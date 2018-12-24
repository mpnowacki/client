// @flow
import * as Chat2Gen from '../chat2-gen'
import * as ConfigGen from '../config-gen'
import * as Constants from '../../constants/chat2'
import * as GregorGen from '../gregor-gen'
import * as I from 'immutable'
import * as FsGen from '../fs-gen'
import * as Flow from '../../util/flow'
import * as NotificationsGen from '../notifications-gen'
import * as RPCChatTypes from '../../constants/types/rpc-chat-gen'
import * as RPCGregorTypes from '../../constants/types/rpc-gregor-gen'
import * as RPCTypes from '../../constants/types/rpc-gen'
import * as RouteTreeGen from '../route-tree-gen'
import * as WalletsGen from '../wallets-gen'
import * as Saga from '../../util/saga'
import * as SearchConstants from '../../constants/search'
import * as SearchGen from '../search-gen'
import * as TeamsGen from '../teams-gen'
import * as Types from '../../constants/types/chat2'
import * as FsTypes from '../../constants/types/fs'
import * as WalletTypes from '../../constants/types/wallets'
import * as Tabs from '../../constants/tabs'
import * as UsersGen from '../users-gen'
import * as WaitingGen from '../waiting-gen'
import chatTeamBuildingSaga from './team-building'
import {hasCanPerform, retentionPolicyToServiceRetentionPolicy, teamRoleByEnum} from '../../constants/teams'
import engine from '../../engine'
import logger from '../../logger'
import type {TypedState} from '../../util/container'
import {isMobile} from '../../constants/platform'
import {getPath} from '../../route-tree'
import {NotifyPopup} from '../../native/notifications'
import {saveAttachmentToCameraRoll, showShareActionSheetFromFile} from '../platform-specific'
import {downloadFilePath} from '../../util/file'
import {privateFolderWithUsers, teamFolder} from '../../constants/config'
import flags from '../../util/feature-flags'

// Ask the service to refresh the inbox
function* inboxRefresh(state, action) {
  if (!state.config.loggedIn) {
    return
  }

  const username = state.config.username || ''

  const onUnverified = function({inbox}) {
    const result: RPCChatTypes.UnverifiedInboxUIItems = JSON.parse(inbox)
    const items: Array<RPCChatTypes.UnverifiedInboxUIItem> = result.items || []
    // We get a subset of meta information from the cache even in the untrusted payload
    const metas = items
      .map(item => Constants.unverifiedInboxUIItemToConversationMeta(item, username))
      .filter(Boolean)
    // Check if some of our existing stored metas might no longer be valid
    const clearExistingMetas =
      action.type === Chat2Gen.inboxRefresh &&
      ['inboxSyncedClear', 'leftAConversation'].includes(action.payload.reason)
    const clearExistingMessages =
      action.type === Chat2Gen.inboxRefresh && action.payload.reason === 'inboxSyncedClear'
    return Saga.put(
      Chat2Gen.createMetasReceived({clearExistingMessages, clearExistingMetas, fromInboxRefresh: true, metas})
    )
  }

  yield Saga.callRPCs(
    RPCChatTypes.localGetInboxNonblockLocalRpcSaga({
      incomingCallMap: {'chat.1.chatUi.chatInboxUnverified': onUnverified},
      params: {
        identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
        maxUnbox: 0,
        query: Constants.makeInboxQuery([]),
        skipUnverified: false,
      },
      waitingKey: Constants.waitingKeyInboxRefresh,
    })
  )
}

// When we get info on a team we need to unbox immediately so we can get the channel names
const requestTeamsUnboxing = (_, action) => {
  const conversationIDKeys = action.payload.metas
    .filter(meta => meta.trustedState === 'untrusted' && meta.teamType === 'big' && !meta.channelname)
    .map(meta => meta.conversationIDKey)
  if (conversationIDKeys.length) {
    return Chat2Gen.createMetaRequestTrusted({
      conversationIDKeys,
    })
  }
}

// Only get the untrusted conversations out
const untrustedConversationIDKeys = (state: TypedState, ids: Array<Types.ConversationIDKey>) =>
  ids.filter(id => state.chat2.metaMap.getIn([id, 'trustedState'], 'untrusted') === 'untrusted')

// We keep a set of conversations to unbox
let metaQueue = I.OrderedSet()
const queueMetaToRequest = (state, action) => {
  const old = metaQueue
  metaQueue = metaQueue.concat(untrustedConversationIDKeys(state, action.payload.conversationIDKeys))
  if (old !== metaQueue) {
    // only unboxMore if something changed
    return Chat2Gen.createMetaHandleQueue()
  } else {
    logger.info('skipping meta queue run, queue unchanged')
  }
}

// Watch the meta queue and take up to 10 items. Choose the last items first since they're likely still visible
function * requestMeta (state, action) {
  const maxToUnboxAtATime = 10
  const maybeUnbox = metaQueue.takeLast(maxToUnboxAtATime)
  metaQueue = metaQueue.skipLast(maxToUnboxAtATime)

  const conversationIDKeys = untrustedConversationIDKeys(state, maybeUnbox.toArray())
  const toUnboxActions = conversationIDKeys.length
    ? [Saga.put(Chat2Gen.createMetaRequestTrusted({conversationIDKeys}))]
    : []
  const unboxSomeMoreActions = metaQueue.size ? [Saga.put(Chat2Gen.createMetaHandleQueue())] : []
  const delayBeforeUnboxingMoreActions =
    toUnboxActions.length && unboxSomeMoreActions.length ? [Saga.callUntyped(Saga.delay, 100)] : []

  const nextActions = [...toUnboxActions, ...delayBeforeUnboxingMoreActions, ...unboxSomeMoreActions]

  if (nextActions.length) {
    return Saga.sequentially(nextActions)
  }
}

// Get valid keys that we aren't already loading or have loaded
const rpcMetaRequestConversationIDKeys = (
  action: Chat2Gen.MetaRequestTrustedPayload | Chat2Gen.SelectConversationPayload,
  state: TypedState
) => {
  let keys
  switch (action.type) {
    case Chat2Gen.metaRequestTrusted:
      keys = action.payload.conversationIDKeys
      if (action.payload.force) {
        return keys.filter(Constants.isValidConversationIDKey)
      }
      break
    case Chat2Gen.selectConversation:
      keys = [action.payload.conversationIDKey].filter(Constants.isValidConversationIDKey)
      break
    default:
      Flow.ifFlowComplainsAboutThisFunctionYouHaventHandledAllCasesInASwitch(action)
      throw new Error('Invalid action passed to unboxRows')
  }
  return Constants.getConversationIDKeyMetasToLoad(keys, state.chat2.metaMap)
}

// We want to unbox rows that have scroll into view
function * unboxRows ( state, action) {
  if (!state.config.loggedIn) {
    return
  }

  const conversationIDKeys = rpcMetaRequestConversationIDKeys(action, state)
  if (!conversationIDKeys.length) {
    return
  }

  const onUnboxed = function({conv}) {
    const inboxUIItem: RPCChatTypes.InboxUIItem = JSON.parse(conv)
    // We allow empty conversations now since we create them and they're empty now
    const allowEmpty = action.type === Chat2Gen.selectConversation
    const meta = Constants.inboxUIItemToConversationMeta(inboxUIItem, allowEmpty)
    const actions = []
    if (meta) {
      actions.push(
        Saga.put(
          Chat2Gen.createMetasReceived({
            metas: [meta],
            neverCreate: action.type === Chat2Gen.metaRequestTrusted,
          })
        )
      )
    } else {
      actions.push(
        Saga.put(
          Chat2Gen.createMetaReceivedError({
            conversationIDKey: Types.stringToConversationIDKey(inboxUIItem.convID),
            error: null, // just remove this item, not a real server error
            username: null,
          })
        )
      )
    }

    const infoMap = state.users.infoMap
    let added = false
    // We get some info about users also so update that too
    const usernameToFullname = Object.keys(inboxUIItem.fullNames).reduce((map, username) => {
      if (!infoMap.get(username)) {
        added = true
        map[username] = inboxUIItem.fullNames[username]
      }
      return map
    }, {})
    if (added) {
      actions.push(Saga.put(UsersGen.createUpdateFullnames({usernameToFullname})))
    }
    return Saga.all(actions)
  }

  const onFailed = ({convID, error}) => {
    const conversationIDKey = Types.conversationIDToKey(convID)
    switch (error.typ) {
      case RPCChatTypes.localConversationErrorType.transient:
        logger.info(
          `onFailed: ignoring transient error for convID: ${conversationIDKey} error: ${error.message}`
        )
        break
      default:
        logger.info(`onFailed: displaying error for convID: ${conversationIDKey} error: ${error.message}`)
        return Saga.callUntyped(function*() {
          const state = yield* Saga.selectState()
          yield Saga.put(
            Chat2Gen.createMetaReceivedError({
              conversationIDKey: conversationIDKey,
              error,
              username: state.config.username || '',
            })
          )
        })
    }
  }

    yield Saga.put(Chat2Gen.createMetaRequestingTrusted({conversationIDKeys}))
    yield RPCChatTypes.localGetInboxNonblockLocalRpcSaga({
      incomingCallMap: {
        'chat.1.chatUi.chatInboxConversation': onUnboxed,
        'chat.1.chatUi.chatInboxFailed': onFailed,
        'chat.1.chatUi.chatInboxUnverified': () => {},
      },
      params: {
        identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
        query: Constants.makeInboxQuery(conversationIDKeys),
        skipUnverified: true,
      },
      waitingKey: Constants.waitingKeyUnboxing(conversationIDKeys[0]),
    })
}

// We get an incoming message streamed to us
const onIncomingMessage = (incoming: RPCChatTypes.IncomingMessage, state: TypedState) => {
  const {
    message: cMsg,
    modifiedMessage,
    convID,
    displayDesktopNotification,
    desktopNotificationSnippet,
  } = incoming
  const actions = []

  if (convID && cMsg) {
    const conversationIDKey = Types.conversationIDToKey(convID)
    const message = Constants.uiMessageToMessage(state, conversationIDKey, cMsg)
    if (message) {
      // The attachmentuploaded call is like an 'edit' of an attachment. We get the placeholder, then its replaced by the actual image
      if (
        cMsg.state === RPCChatTypes.chatUiMessageUnboxedState.valid &&
        cMsg.valid &&
        cMsg.valid.messageBody.messageType === RPCChatTypes.commonMessageType.attachmentuploaded &&
        cMsg.valid.messageBody.attachmentuploaded &&
        message.type === 'attachment'
      ) {
        actions.push(
          Chat2Gen.createMessageAttachmentUploaded({
            conversationIDKey,
            message,
            placeholderID: cMsg.valid.messageBody.attachmentuploaded.messageID,
          })
        )
      } else {
        // A normal message
        actions.push(Chat2Gen.createMessagesAdd({context: {type: 'incoming'}, messages: [message]}))
      }
    } else if (cMsg.state === RPCChatTypes.chatUiMessageUnboxedState.valid && cMsg.valid) {
      const valid = cMsg.valid
      const body = valid.messageBody
      logger.info(`Got chat incoming message of messageType: ${body.messageType}`)
      // Types that are mutations
      switch (body.messageType) {
        case RPCChatTypes.commonMessageType.edit:
          if (modifiedMessage) {
            const modMessage = Constants.uiMessageToMessage(state, conversationIDKey, modifiedMessage)
            if (modMessage) {
              actions.push(Chat2Gen.createMessagesAdd({context: {type: 'incoming'}, messages: [modMessage]}))
            }
          }
          break
        case RPCChatTypes.commonMessageType.delete:
          if (body.delete && body.delete.messageIDs) {
            // check if the delete is acting on an exploding message
            const messageIDs = body.delete.messageIDs
            const messages = state.chat2.messageMap.get(conversationIDKey)
            const isExplodeNow =
              !!messages &&
              messageIDs.some(_id => {
                const id = Types.numberToOrdinal(_id)
                const message = messages.get(id) || messages.find(msg => msg.id === id)
                if (
                  message &&
                  (message.type === 'text' || message.type === 'attachment') &&
                  message.exploding
                ) {
                  return true
                }
                return false
              })

            actions.push(
              isExplodeNow
                ? Chat2Gen.createMessagesExploded({
                    conversationIDKey,
                    explodedBy: valid.senderUsername,
                    messageIDs: messageIDs,
                  })
                : Chat2Gen.createMessagesWereDeleted({conversationIDKey, messageIDs})
            )
          }
          break
      }
    }
    if (
      !isMobile &&
      displayDesktopNotification &&
      desktopNotificationSnippet &&
      cMsg.state === RPCChatTypes.chatUiMessageUnboxedState.valid &&
      cMsg.valid
    ) {
      actions.push(
        Chat2Gen.createDesktopNotification({
          author: cMsg.valid.senderUsername,
          body: desktopNotificationSnippet,
          conversationIDKey,
        })
      )
    }
  }

  // We need to do things and we need to consume the inbox updates that come along with this data
  return [...actions, ...chatActivityToMetasAction(incoming)]
}

// Helper to handle incoming inbox updates that piggy back on various calls
const chatActivityToMetasAction = (payload: ?{+conv?: ?RPCChatTypes.InboxUIItem}) => {
  const conv = payload ? payload.conv : null
  const meta = conv && Constants.inboxUIItemToConversationMeta(conv)
  const conversationIDKey = meta
    ? meta.conversationIDKey
    : conv && Types.stringToConversationIDKey(conv.convID)
  const usernameToFullname = (conv && conv.fullNames) || {}
  // We ignore inbox rows that are ignored/blocked/reported or have no content
  const isADelete =
    conv &&
    ([
      RPCChatTypes.commonConversationStatus.ignored,
      RPCChatTypes.commonConversationStatus.blocked,
      RPCChatTypes.commonConversationStatus.reported,
    ].includes(conv.status) ||
      conv.isEmpty)

  // We want to select a different convo if its cause we ignored/blocked/reported. Otherwise sometimes we get that a convo
  // is empty which we don't want to select something else as sometimes we're in the middle of making it!
  const selectSomethingElse = conv ? !conv.isEmpty : false
  return meta
    ? [
        isADelete
          ? Chat2Gen.createMetaDelete({conversationIDKey: meta.conversationIDKey, selectSomethingElse})
          : Chat2Gen.createMetasReceived({metas: [meta]}),
        UsersGen.createUpdateFullnames({usernameToFullname}),
      ]
    : conversationIDKey && isADelete
    ? [Chat2Gen.createMetaDelete({conversationIDKey, selectSomethingElse})]
    : []
}

// We got errors from the service
const onErrorMessage = (outboxRecords: Array<RPCChatTypes.OutboxRecord>, you: string) => {
  const actions = outboxRecords.reduce((arr, outboxRecord) => {
    const s = outboxRecord.state
    if (s.state === RPCChatTypes.localOutboxStateType.error) {
      const error = s.error

      const conversationIDKey = Types.conversationIDToKey(outboxRecord.convID)
      const outboxID = Types.rpcOutboxIDToOutboxID(outboxRecord.outboxID)

      if (error) {
        // This is temp until fixed by CORE-7112. We get this error but not the call to let us show the red banner
        const reason = Constants.rpcErrorToString(error)
        let tempForceRedBox
        if (error.typ === RPCChatTypes.localOutboxErrorType.identify) {
          // Find out the user who failed identify
          const match = error.message && error.message.match(/"(.*)"/)
          tempForceRedBox = match && match[1]
        }
        arr.push(Chat2Gen.createMessageErrored({conversationIDKey, outboxID, reason}))
        if (tempForceRedBox) {
          arr.push(UsersGen.createUpdateBrokenState({newlyBroken: [tempForceRedBox], newlyFixed: []}))
        }
      }
    }
    return arr
  }, [])

  return actions
}

// Service tells us it's done syncing
const onChatInboxSynced = (syncRes, state) => {
  const actions = [WaitingGen.createClearWaiting({key: Constants.waitingKeyInboxSyncStarted})]

  switch (syncRes.syncType) {
    // Just clear it all
    case RPCChatTypes.commonSyncInboxResType.clear:
      actions.push(Chat2Gen.createInboxRefresh({reason: 'inboxSyncedClear'}))
      break
    // We're up to date
    case RPCChatTypes.commonSyncInboxResType.current:
      break
    // We got some new messages appended
    case RPCChatTypes.commonSyncInboxResType.incremental: {
      const selectedConversation = Constants.getSelectedConversation(state)
      const username = state.config.username || ''
      const items = (syncRes.incremental && syncRes.incremental.items) || []
      const metas = items.reduce((arr, i) => {
        const meta = Constants.unverifiedInboxUIItemToConversationMeta(i.conv, username)
        if (meta) {
          if (meta.conversationIDKey === selectedConversation) {
            // First thing load the messages
            actions.unshift(
              Chat2Gen.createMarkConversationsStale({
                conversationIDKeys: [selectedConversation],
                updateType: RPCChatTypes.notifyChatStaleUpdateType.newactivity,
              })
            )
          }
          arr.push(meta)
        }
        return arr
      }, [])
      // Update new untrusted
      if (metas.length) {
        actions.push(Chat2Gen.createMetasReceived({metas}))
      }
      // Unbox items
      actions.push(
        Chat2Gen.createMetaRequestTrusted({
          conversationIDKeys: items
            .filter(i => i.shouldUnbox)
            .map(i => Types.stringToConversationIDKey(i.conv.convID)),
          force: true,
        })
      )
      break
    }
    default:
      actions.push(Chat2Gen.createInboxRefresh({reason: 'inboxSyncedUnknown'}))
  }
  return actions
}

// Got some new typers
const onChatTypingUpdate = typingUpdates => {
  if (!typingUpdates) {
    return null
  } else {
    const conversationToTypers = I.Map(
      typingUpdates.reduce((arr, u) => {
        arr.push([Types.conversationIDToKey(u.convID), I.Set((u.typers || []).map(t => t.username))])
        return arr
      }, [])
    )
    return [Chat2Gen.createUpdateTypers({conversationToTypers})]
  }
}

const onChatThreadStale = updates => {
  let actions = []
  Object.keys(RPCChatTypes.notifyChatStaleUpdateType).forEach(function(key) {
    const conversationIDKeys = (updates || []).reduce((arr, u) => {
      if (u.updateType === RPCChatTypes.notifyChatStaleUpdateType[key]) {
        arr.push(Types.conversationIDToKey(u.convID))
      }
      return arr
    }, [])
    // load the inbox instead
    if (key === 'convupdate') {
      logger.info(
        `onChatThreadStale: dispatching inbox unbox actions for ${
          conversationIDKeys.length
        } convs of type ${key}`
      )
      actions = actions.concat([
        Chat2Gen.createMetaRequestTrusted({
          conversationIDKeys,
          force: true,
        }),
      ])
    } else if (conversationIDKeys.length > 0) {
      logger.info(
        `onChatThreadStale: dispatching thread reload actions for ${
          conversationIDKeys.length
        } convs of type ${key}`
      )
      actions = actions.concat([
        Chat2Gen.createMarkConversationsStale({
          conversationIDKeys,
          updateType: RPCChatTypes.notifyChatStaleUpdateType[key],
        }),
        Chat2Gen.createMetaRequestTrusted({
          conversationIDKeys,
          force: true,
        }),
      ])
    }
  })
  return actions
}

const onChatSubteamRename = convs => {
  const conversationIDKeys = (convs || []).map(c => Types.stringToConversationIDKey(c.convID))
  return Saga.put(
    Chat2Gen.createMetaRequestTrusted({
      conversationIDKeys,
      force: true,
    })
  )
}

// Some participants are broken/fixed now
const onChatIdentifyUpdate = update => {
  const usernames = update.CanonicalName.split(',')
  const broken = (update.breaks.breaks || []).map(b => b.user.username)
  const newlyBroken = []
  const newlyFixed = []

  usernames.forEach(name => {
    if (broken.includes(name)) {
      newlyBroken.push(name)
    } else {
      newlyFixed.push(name)
    }
  })

  return Saga.put(UsersGen.createUpdateBrokenState({newlyBroken, newlyFixed}))
}

// Get actions to update messagemap / metamap when retention policy expunge happens
const expungeToActions = (expunge: RPCChatTypes.ExpungeInfo, state: TypedState) => {
  const actions = []
  const meta = !!expunge.conv && Constants.inboxUIItemToConversationMeta(expunge.conv)
  if (meta) {
    actions.push(Chat2Gen.createMetasReceived({fromExpunge: true, metas: [meta]}))
  }
  const conversationIDKey = Types.conversationIDToKey(expunge.convID)
  actions.push(
    Chat2Gen.createMessagesWereDeleted({
      conversationIDKey,
      deletableMessageTypes: Constants.getDeletableByDeleteHistory(state),
      upToMessageID: expunge.expunge.upto,
    })
  )
  return actions
}

// Get actions to update messagemap / metamap when ephemeral messages expire
const ephemeralPurgeToActions = (info: RPCChatTypes.EphemeralPurgeNotifInfo) => {
  const actions = []
  const conversationIDKey = Types.conversationIDToKey(info.convID)
  const messageIDs =
    !!info.msgs &&
    info.msgs.reduce((arr, msg) => {
      const msgID = Constants.getMessageID(msg)
      if (msgID) {
        arr.push(msgID)
      }
      return arr
    }, [])
  !!messageIDs && actions.push(Chat2Gen.createMessagesExploded({conversationIDKey, messageIDs}))
  return actions
}

const messagesUpdatedToActions = (info: RPCChatTypes.MessagesUpdated, state: TypedState) => {
  const conversationIDKey = Types.conversationIDToKey(info.convID)
  const messages = (info.updates || []).reduce((l, msg) => {
    const messageID = Constants.getMessageID(msg)
    if (!messageID) {
      return l
    }
    const uiMsg = Constants.uiMessageToMessage(state, conversationIDKey, msg)
    if (!uiMsg) {
      return l
    }
    return l.concat({
      message: uiMsg,
      messageID: Types.numberToMessageID(messageID),
    })
  }, [])
  return [Chat2Gen.createUpdateMessages({conversationIDKey, messages})]
}

// Get actions to update the messagemap when reactions are updated
const reactionUpdateToActions = (info: RPCChatTypes.ReactionUpdateNotif) => {
  const conversationIDKey = Types.conversationIDToKey(info.convID)
  if (!info.reactionUpdates || info.reactionUpdates.length === 0) {
    logger.warn(`Got ReactionUpdateNotif with no reactionUpdates for convID=${conversationIDKey}`)
    return null
  }
  const updates = info.reactionUpdates.map(ru => ({
    reactions: Constants.reactionMapToReactions(ru.reactions),
    targetMsgID: ru.targetMsgID,
  }))
  logger.info(`Got ${updates.length} reaction updates for convID=${conversationIDKey}`)
  return [Chat2Gen.createUpdateReactions({conversationIDKey, updates})]
}

// This is to simplify the changes that setIncomingCallMap created. Could clean this up and remove this
const arrayOfActionsToSequentially = actions =>
  Saga.callUntyped(Saga.sequentially, (actions || []).map(a => Saga.put(a)))

// Handle calls that come from the service
const setupEngineListeners = () => {
  engine().setIncomingCallMap({
    'chat.1.NotifyChat.ChatAttachmentUploadProgress': ({convID, outboxID, bytesComplete, bytesTotal}) => {
      const conversationIDKey = Types.conversationIDToKey(convID)
      const ratio = bytesComplete / bytesTotal
      return Saga.put(
        Chat2Gen.createAttachmentUploading({
          conversationIDKey,
          outboxID: Types.rpcOutboxIDToOutboxID(outboxID),
          ratio,
        })
      )
    },
    'chat.1.NotifyChat.ChatAttachmentUploadStart': ({convID, outboxID}) => {
      const conversationIDKey = Types.conversationIDToKey(convID)
      return Saga.put(
        Chat2Gen.createAttachmentUploading({
          conversationIDKey,
          outboxID: Types.rpcOutboxIDToOutboxID(outboxID),
          ratio: 0.01,
        })
      )
    },
    'chat.1.NotifyChat.ChatIdentifyUpdate': ({update}) => onChatIdentifyUpdate(update),
    'chat.1.NotifyChat.ChatInboxStale': () => Saga.put(Chat2Gen.createInboxRefresh({reason: 'inboxStale'})),
    'chat.1.NotifyChat.ChatInboxSyncStarted': () =>
      Saga.put(WaitingGen.createIncrementWaiting({key: Constants.waitingKeyInboxSyncStarted})),
    'chat.1.NotifyChat.ChatInboxSynced': ({syncRes}) =>
      Saga.callUntyped(function*() {
        const state = yield* Saga.selectState()
        yield arrayOfActionsToSequentially(onChatInboxSynced(syncRes, state))
      }),
    'chat.1.NotifyChat.ChatJoinedConversation': () =>
      Saga.put(Chat2Gen.createInboxRefresh({reason: 'joinedAConversation'})),
    'chat.1.NotifyChat.ChatLeftConversation': () =>
      Saga.put(Chat2Gen.createInboxRefresh({reason: 'leftAConversation'})),
    'chat.1.NotifyChat.ChatPaymentInfo': notif => {
      const conversationIDKey = notif.convID
        ? Types.conversationIDToKey(notif.convID)
        : Constants.noConversationIDKey
      const paymentInfo = Constants.uiPaymentInfoToChatPaymentInfo([notif.info])
      if (!paymentInfo) {
        // This should never happen
        const errMsg = `ChatHandler: got 'NotifyChat.ChatPaymentInfo' with no valid paymentInfo for convID ${conversationIDKey} messageID: ${
          notif.msgID
        }. The local version may be absent or out of date.`
        logger.error(errMsg)
        throw new Error(errMsg)
      }
      return Saga.put(
        Chat2Gen.createPaymentInfoReceived({
          conversationIDKey,
          messageID: notif.msgID,
          paymentInfo,
        })
      )
    },
    'chat.1.NotifyChat.ChatPromptUnfurl': notif => {
      const conversationIDKey = Types.conversationIDToKey(notif.convID)
      const messageID = Types.numberToMessageID(notif.msgID)
      const domain = notif.domain
      return Saga.put(
        Chat2Gen.createUnfurlTogglePrompt({
          conversationIDKey,
          domain,
          messageID,
          show: true,
        })
      )
    },
    'chat.1.NotifyChat.ChatRequestInfo': notif => {
      const conversationIDKey = Types.conversationIDToKey(notif.convID)
      const requestInfo = Constants.uiRequestInfoToChatRequestInfo(notif.info)
      if (!requestInfo) {
        // This should never happen
        const errMsg = `ChatHandler: got 'NotifyChat.ChatRequestInfo' with no valid requestInfo for convID ${conversationIDKey} messageID: ${
          notif.msgID
        }. The local version may be absent or out of date.`
        logger.error(errMsg)
        throw new Error(errMsg)
      }
      return Saga.put(
        Chat2Gen.createRequestInfoReceived({
          conversationIDKey,
          messageID: notif.msgID,
          requestInfo,
        })
      )
    },
    'chat.1.NotifyChat.ChatSetConvRetention': ({conv, convID}) => {
      if (conv) {
        return Saga.put(Chat2Gen.createUpdateConvRetentionPolicy({conv}))
      }
      logger.warn(
        'ChatHandler: got NotifyChat.ChatSetConvRetention with no attached InboxUIItem. Forcing update.'
      )
      // force to get the new retention policy
      return Saga.put(
        Chat2Gen.createMetaRequestTrusted({
          conversationIDKeys: [Types.conversationIDToKey(convID)],
          force: true,
        })
      )
    },
    'chat.1.NotifyChat.ChatSetConvSettings': ({conv, convID}) => {
      const conversationIDKey = Types.conversationIDToKey(convID)
      const newRole =
        conv &&
        conv.convSettings &&
        conv.convSettings.minWriterRoleInfo &&
        conv.convSettings.minWriterRoleInfo.role
      const role = newRole && teamRoleByEnum[newRole]
      logger.info(`ChatHandler: got new minWriterRole ${role || ''} for convID ${conversationIDKey}`)
      if (role && role !== 'none') {
        return Saga.put(Chat2Gen.createSaveMinWriterRole({conversationIDKey, role}))
      }
      logger.warn(
        `ChatHandler: got NotifyChat.ChatSetConvSettings with no valid minWriterRole for convID ${conversationIDKey}. The local version may be out of date.`
      )
    },
    'chat.1.NotifyChat.ChatSetTeamRetention': ({convs}) => {
      if (convs) {
        return Saga.put(Chat2Gen.createUpdateTeamRetentionPolicy({convs}))
      }
      // this is a more serious problem, but we don't need to bug the user about it
      logger.error(
        'ChatHandler: got NotifyChat.ChatSetTeamRetention with no attached InboxUIItems. The local version may be out of date'
      )
    },
    'chat.1.NotifyChat.ChatSubteamRename': ({convs}) => onChatSubteamRename(convs),
    'chat.1.NotifyChat.ChatTLFFinalize': ({convID}) =>
      Saga.put(Chat2Gen.createMetaRequestTrusted({conversationIDKeys: [Types.conversationIDToKey(convID)]})),
    'chat.1.NotifyChat.ChatThreadsStale': ({updates}) =>
      arrayOfActionsToSequentially(onChatThreadStale(updates)),
    'chat.1.NotifyChat.ChatTypingUpdate': ({typingUpdates}) =>
      arrayOfActionsToSequentially(onChatTypingUpdate(typingUpdates)),
    'chat.1.NotifyChat.NewChatActivity': ({activity}) => {
      logger.info(`Got new chat activity of type: ${activity.activityType}`)
      switch (activity.activityType) {
        case RPCChatTypes.notifyChatChatActivityType.incomingMessage: {
          const incomingMessage = activity.incomingMessage
          return incomingMessage
            ? Saga.callUntyped(function*() {
                const state = yield* Saga.selectState()
                yield arrayOfActionsToSequentially(onIncomingMessage(incomingMessage, state))
              })
            : null
        }
        case RPCChatTypes.notifyChatChatActivityType.setStatus:
          return arrayOfActionsToSequentially(chatActivityToMetasAction(activity.setStatus))
        case RPCChatTypes.notifyChatChatActivityType.readMessage:
          return arrayOfActionsToSequentially(chatActivityToMetasAction(activity.readMessage))
        case RPCChatTypes.notifyChatChatActivityType.newConversation:
          return arrayOfActionsToSequentially(chatActivityToMetasAction(activity.newConversation))
        case RPCChatTypes.notifyChatChatActivityType.failedMessage: {
          const failedMessage: ?RPCChatTypes.FailedMessageInfo = activity.failedMessage
          const outboxRecords = failedMessage && failedMessage.outboxRecords
          return outboxRecords
            ? Saga.callUntyped(function*() {
                const state = yield* Saga.selectState()
                yield arrayOfActionsToSequentially(onErrorMessage(outboxRecords, state.config.username))
              })
            : null
        }
        case RPCChatTypes.notifyChatChatActivityType.membersUpdate:
          const convID = activity.membersUpdate && activity.membersUpdate.convID
          return (
            convID &&
            Saga.put(
              Chat2Gen.createMetaRequestTrusted({
                conversationIDKeys: [Types.conversationIDToKey(convID)],
                force: true,
              })
            )
          )
        case RPCChatTypes.notifyChatChatActivityType.setAppNotificationSettings:
          const setAppNotificationSettings: ?RPCChatTypes.SetAppNotificationSettingsInfo =
            activity.setAppNotificationSettings
          return (
            setAppNotificationSettings &&
            Saga.put(
              Chat2Gen.createNotificationSettingsUpdated({
                conversationIDKey: Types.conversationIDToKey(setAppNotificationSettings.convID),
                settings: setAppNotificationSettings.settings,
              })
            )
          )
        case RPCChatTypes.notifyChatChatActivityType.teamtype:
          return Saga.put(Chat2Gen.createInboxRefresh({reason: 'teamTypeChanged'}))
        case RPCChatTypes.notifyChatChatActivityType.expunge: {
          const expunge = activity.expunge
          return expunge
            ? Saga.callUntyped(function*() {
                const state = yield* Saga.selectState()
                yield arrayOfActionsToSequentially(expungeToActions(expunge, state))
              })
            : null
        }
        case RPCChatTypes.notifyChatChatActivityType.ephemeralPurge:
          return activity.ephemeralPurge
            ? arrayOfActionsToSequentially(ephemeralPurgeToActions(activity.ephemeralPurge))
            : null
        case RPCChatTypes.notifyChatChatActivityType.reactionUpdate:
          return activity.reactionUpdate
            ? arrayOfActionsToSequentially(reactionUpdateToActions(activity.reactionUpdate))
            : null
        case RPCChatTypes.notifyChatChatActivityType.messagesUpdated: {
          const messagesUpdated = activity.messagesUpdated
          return messagesUpdated
            ? Saga.callUntyped(function*() {
                const state = yield* Saga.selectState()
                yield arrayOfActionsToSequentially(messagesUpdatedToActions(messagesUpdated, state))
              })
            : null
        }
        default:
          break
      }
    },
  })
}

const loadThreadMessageTypes = Object.keys(RPCChatTypes.commonMessageType).reduce((arr, key) => {
  switch (key) {
    case 'none':
    case 'edit': // daemon filters this out for us so we can ignore
    case 'delete':
    case 'attachmentuploaded':
    case 'reaction':
    case 'unfurl':
      break
    default:
      arr.push(RPCChatTypes.commonMessageType[key])
      break
  }

  return arr
}, [])

const reasonToRPCReason = (reason: string): RPCChatTypes.GetThreadReason => {
  switch (reason) {
    case 'extension':
    case 'push':
      return RPCChatTypes.commonGetThreadReason.push
    case 'foregrounding':
      return RPCChatTypes.commonGetThreadReason.foreground
    default:
      return RPCChatTypes.commonGetThreadReason.general
  }
}

// Load new messages on a thread. We call this when you select a conversation, we get a thread-is-stale notification, or when you scroll up and want more messages
function * loadMoreMessages = ( state, action) => {
  // Get the conversationIDKey
  let key = null
  let reason: string = ''

  switch (action.type) {
    case ConfigGen.changedFocus:
      if (!isMobile || !action.payload.appFocused) {
        return
      }
      key = Constants.getSelectedConversation(state)
      reason = 'foregrounding'
      break
    case Chat2Gen.setPendingConversationUsers:
      if (Constants.getSelectedConversation(state) !== Constants.pendingConversationIDKey) {
        return
      }
      reason = 'building a search'
      // we stash the actual preview conversation id key in here
      key = Constants.getResolvedPendingConversationIDKey(state)
      break
    case Chat2Gen.setPendingConversationExistingConversationIDKey:
      if (Constants.getSelectedConversation(state) !== Constants.pendingConversationIDKey) {
        // We're not looking at it so ignore
        return
      }
      reason = 'got search preview conversationidkey'
      key = Constants.getResolvedPendingConversationIDKey(state)
      break
    case Chat2Gen.markConversationsStale:
      key = Constants.getSelectedConversation(state)
      // not mentioned?
      if (action.payload.conversationIDKeys.indexOf(key) === -1) {
        return
      }
      reason = 'got stale'
      break
    case Chat2Gen.selectConversation:
      key = action.payload.conversationIDKey
      reason = action.payload.reason || 'selected'

      if (key === Constants.pendingConversationIDKey) {
        key = Constants.getResolvedPendingConversationIDKey(state)
      }
      break
    case Chat2Gen.metasReceived:
      if (!action.payload.clearExistingMessages) {
        // we didn't clear anything out, we don't need to fetch anything
        return
      }
      key = Constants.getSelectedConversation(state)
      break
    case Chat2Gen.loadOlderMessagesDueToScroll:
      key = action.payload.conversationIDKey
      if (action.payload.conversationIDKey === Constants.pendingConversationIDKey) {
        key = Constants.getResolvedPendingConversationIDKey(state)
      }
      break
    default:
      Flow.ifFlowComplainsAboutThisFunctionYouHaventHandledAllCasesInASwitch(action.type)
      key = action.payload.conversationIDKey
  }

  if (!key || !Constants.isValidConversationIDKey(key)) {
    logger.info('Load thread bail: no conversationIDKey')
    return
  }

  const conversationIDKey = key

  const conversationID = Types.keyToConversationID(conversationIDKey)
  if (!conversationID) {
    logger.info('Load thread bail: invalid conversationIDKey')
    return
  }

  let numberOfMessagesToLoad
  let isScrollingBack = false

  const meta = Constants.getMeta(state, conversationIDKey)

  if (meta.membershipType === 'youAreReset' || !meta.rekeyers.isEmpty()) {
    logger.info('Load thread bail: we are reset')
    return
  }

  if (action.type === Chat2Gen.loadOlderMessagesDueToScroll) {
    if (!state.chat2.moreToLoadMap.get(conversationIDKey)) {
      logger.info('Load thread bail: scrolling back and at the end')
      return
    }
    isScrollingBack = true
    numberOfMessagesToLoad = Constants.numMessagesOnScrollback
  } else {
    numberOfMessagesToLoad = Constants.numMessagesOnInitialLoad
  }

  logger.info(
    `Load thread: calling rpc convo: ${conversationIDKey} num: ${numberOfMessagesToLoad} reason: ${reason}`
  )

  const loadingKey = Constants.waitingKeyThreadLoad(conversationIDKey)

  let calledClear = false
  const onGotThread = ({thread}: {+thread: ?string}, context: 'full' | 'cached') => {
    if (!thread) {
      return
    }

    const uiMessages: RPCChatTypes.UIMessages = JSON.parse(thread)

    const actions = []

    let shouldClearOthers = false
    if (!isScrollingBack && !calledClear) {
      shouldClearOthers = true
      calledClear = true
    }

    const messages = (uiMessages.messages || []).reduce((arr, m) => {
      const message = conversationIDKey ? Constants.uiMessageToMessage(state, conversationIDKey, m) : null
      if (message) {
        arr.push(message)
      }
      return arr
    }, [])

    const moreToLoad = uiMessages.pagination ? !uiMessages.pagination.last : true
    actions.push(Saga.put(Chat2Gen.createUpdateMoreToLoad({conversationIDKey, moreToLoad})))

    if (messages.length) {
      actions.push(
        Saga.put(
          Chat2Gen.createMessagesAdd({
            context: {conversationIDKey, type: 'threadLoad'},
            messages,
            shouldClearOthers,
          })
        )
      )
    }

    return actions
  }

    try {
      const results: RPCChatTypes.NonblockFetchRes = yield RPCChatTypes.localGetThreadNonblockRpcSaga({
        incomingCallMap: {
          'chat.1.chatUi.chatThreadCached': p => onGotThread(p, 'cached'),
          'chat.1.chatUi.chatThreadFull': p => onGotThread(p, 'full'),
        },
        params: {
          cbMode: RPCChatTypes.localGetThreadNonblockCbMode.incremental,
          conversationID,
          identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
          pagination: {
            last: false,
            next: isScrollingBack ? 'deadbeef' : '', // daemon treats this as a boolean essentially. string means to scroll back, null means an initial load
            num: numberOfMessagesToLoad,
            previous: '',
          },
          pgmode: RPCChatTypes.localGetThreadNonblockPgMode.server,
          query: {
            disablePostProcessThread: false,
            disableResolveSupersedes: false,
            enableDeletePlaceholders: true,
            markAsRead: false,
            messageTypes: loadThreadMessageTypes,
          },
          reason: reasonToRPCReason(reason),
        },
        waitingKey: loadingKey,
      })
      yield Saga.put(
        Chat2Gen.createSetConversationOffline({conversationIDKey, offline: results && results.offline})
      )
    } finally {
      yield Saga.put(WaitingGen.createClearWaiting({key: Constants.waitingKeyPushLoad(conversationIDKey)}))
    }
}

const clearInboxFilter = ( state, action) => {
  if (!state.chat2.inboxFilter) {
    return
  }

  if (
    action.type === Chat2Gen.selectConversation &&
    (action.payload.reason === 'inboxFilterArrow' || action.payload.reason === 'inboxFilterChanged')
  ) {
    return
  }

  return Chat2Gen.createSetInboxFilter({filter: ''})
}

// Show a desktop notification
function* desktopNotify(state, action) {
  const {conversationIDKey, author, body} = action.payload
  const meta = Constants.getMeta(state, conversationIDKey)

  if (
    Constants.isUserActivelyLookingAtThisThread(state, conversationIDKey) ||
    meta.isMuted // ignore muted convos
  ) {
    logger.info('desktopNotify: not sending notification')
    return
  }

  logger.info('desktopNotify: sending chat notification')
  let title = ['small', 'big'].includes(meta.teamType) ? meta.teamname : author
  if (meta.teamType === 'big') {
    title += `#${meta.channelname}`
  }

  const actions = yield Saga.callUntyped(
    () =>
      new Promise(resolve => {
        const onClick = () => {
          resolve(
            Saga.sequentially([
              Saga.put(
                Chat2Gen.createSelectConversation({
                  conversationIDKey,
                  reason: 'desktopNotification',
                })
              ),
              Saga.put(RouteTreeGen.createSwitchTo({path: [Tabs.chatTab]})),
              Saga.put(ConfigGen.createShowMain()),
            ])
          )
        }
        const onClose = () => {
          resolve()
        }
        logger.info('desktopNotify: invoking NotifyPopup for chat notification')
        NotifyPopup(title, {body, sound: state.config.notifySound}, -1, author, onClick, onClose)
      })
  )
  if (actions) {
    yield actions
  }
}

// Delete a message. We cancel pending messages
const messageDelete = (state, action) => {
  const {conversationIDKey, ordinal} = action.payload
  const message = state.chat2.messageMap.getIn([conversationIDKey, ordinal])
  if (
    !message ||
    (message.type !== 'text' && message.type !== 'attachment' && message.type !== 'requestPayment')
  ) {
    logger.warn('Deleting non-existant or, non-text non-attachment non-requestPayment message')
    logger.debug('Deleting invalid message:', message)
    return
  }

  const meta = state.chat2.metaMap.get(conversationIDKey)
  if (!meta) {
    logger.warn('Deleting message w/ no meta')
    logger.debug('Deleting message w/ no meta', message)
    return
  }

  // We have to cancel pending messages
  if (!message.id) {
    if (message.outboxID) {
      return RPCChatTypes.localCancelPostRpcPromise(
          {outboxID: Types.outboxIDToRpcOutboxID(message.outboxID)},
          Constants.waitingKeyCancelPost
      ).then(() => Chat2Gen.createMessagesWereDeleted({conversationIDKey, ordinals: [message.ordinal]})),
    } else {
      logger.warn('Delete of no message id and no outboxid')
    }
  } else {
    return RPCChatTypes.localPostDeleteNonblockRpcPromise(
      {
        clientPrev: 0,
        conversationID: Types.keyToConversationID(conversationIDKey),
        identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
        outboxID: null,
        supersedes: message.id,
        tlfName: meta.tlfname,
        tlfPublic: false,
      },
      Constants.waitingKeyDeletePost
    )
  }
}

const clearMessageSetEditing = (state, action) =>
    Chat2Gen.createMessageSetEditing({
      conversationIDKey: action.payload.conversationIDKey,
      ordinal: null,
    })

const getIdentifyBehavior = (state: TypedState, conversationIDKey: Types.ConversationIDKey) => {
  return RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui
}

function * messageReplyPrivately (state, action) {
  const {sourceConversationIDKey, ordinal} = action.payload
  const message = Constants.getMessage(state, sourceConversationIDKey, ordinal)
  if (!message) {
    logger.warn("Can't find message to reply to", ordinal)
    return
  }

    const result: RPCChatTypes.NewConversationLocalRes = yield createConversation(
      Chat2Gen.createCreateConversation({participants: [message.author]}),
      state
    )
    const conversationIDKey = Types.conversationIDToKey(result.conv.info.id)
    yield Saga.sequentially([
      Saga.put(Chat2Gen.createSelectConversation({conversationIDKey, reason: 'createdMessagePrivately'})),
      Saga.put(
        Chat2Gen.createMessageSetQuoting({
          ordinal: action.payload.ordinal,
          sourceConversationIDKey: action.payload.sourceConversationIDKey,
          targetConversationIDKey: conversationIDKey,
        })
      ),
    ])
}

function * messageEdit (state, action) {
  const {conversationIDKey, text, ordinal} = action.payload
  const message = Constants.getMessage(state, conversationIDKey, ordinal)
  if (!message) {
    logger.warn("Can't find message to edit", ordinal)
    return
  }

  if (message.type === 'text') {
    // Skip if the content is the same
    if (message.text.stringValue() === text.stringValue()) {
      yield Saga.put(Chat2Gen.createMessageSetEditing({conversationIDKey, ordinal: null}))
      return
    }

    const meta = Constants.getMeta(state, conversationIDKey)
    const tlfName = meta.tlfname
    const clientPrev = Constants.getClientPrev(state, conversationIDKey)
    const outboxID = Constants.generateOutboxID()
    const target = {
      messageID: message.id,
      outboxID: message.outboxID ? Types.outboxIDToRpcOutboxID(message.outboxID) : null,
    }
    let actions = [
      Saga.callUntyped(
        RPCChatTypes.localPostEditNonblockRpcPromise,
        {
          body: text.stringValue(),
          clientPrev,
          conversationID: Types.keyToConversationID(conversationIDKey),
          identifyBehavior: getIdentifyBehavior(state, conversationIDKey),
          outboxID,
          target,
          tlfName,
          tlfPublic: false,
        },
        Constants.waitingKeyEditPost
      ),
    ]
    if (!message.id) {
      actions = actions.concat(
        Saga.put(Chat2Gen.createPendingMessageWasEdited({conversationIDKey, ordinal, text}))
      )
    }
    yield Saga.sequentially(actions)
  } else {
    logger.warn('Editing non-text message')
  }
}

const messageRetry = (state, action) => {
  const {outboxID} = action.payload
    return RPCChatTypes.localRetryPostRpcPromise(
    { outboxID: Types.outboxIDToRpcOutboxID(outboxID), },
    Constants.waitingKeyRetryPost
  )
}

function * messageSend (state, action) {
    const {conversationIDKey, text} = action.payload
    const outboxID = Constants.generateOutboxID()
    const meta = Constants.getMeta(state, conversationIDKey)
    const tlfName = meta.tlfname
    const clientPrev = Constants.getClientPrev(state, conversationIDKey)

    // disable sending exploding messages if flag is false
    const ephemeralLifetime = Constants.getConversationExplodingMode(state, conversationIDKey)
    const ephemeralData = ephemeralLifetime !== 0 ? {ephemeralLifetime} : {}
    const newMsg = Constants.makePendingTextMessage(
      state,
      conversationIDKey,
      text,
      Types.stringToOutboxID(outboxID.toString('hex') || ''), // never null but makes flow happy
      ephemeralLifetime
    )

    const routeName = 'paymentsConfirm'
    const addMessage = (p, response) => [
      Saga.put(
        Chat2Gen.createMessagesAdd({
          context: {type: 'sent'},
          messages: [newMsg],
        })
      ),
      // We need to make extra certain that the message is added into the store before
      // we get any callbacks from the service for that same message. Currently, it seems possible
      // that with a mixed custom and vanilla call map those actions generated from the
      // service can interleave, and cause a duplicate message.
      Saga.callUntyped(function() {
        response && response.result()
      }),
    ]
    const onShowConfirm = () => [
      Saga.put(Chat2Gen.createClearPaymentConfirmInfo()),
      Saga.put(
        RouteTreeGen.createNavigateAppend({
          path: [routeName],
        })
      ),
    ]
    const onHideConfirm = () =>
      Saga.callUntyped(function*() {
        const state = yield* Saga.selectState()
        if (getPath(state.routeTree.routeState).last() === routeName) {
          yield Saga.put(RouteTreeGen.createNavigateUp())
        }
      })
    const onDataConfirm = ({summary}, response) => {
      stellarConfirmWindowResponse = response
      return Saga.put(Chat2Gen.createSetPaymentConfirmInfo({summary}))
    }
    const onDataError = ({message}, response) => {
      stellarConfirmWindowResponse = response
      return Saga.put(Chat2Gen.createSetPaymentConfirmInfoError({error: message}))
    }
  try {
    yield RPCChatTypes.localPostTextNonblockRpcSaga({
      customResponseIncomingCallMap: {
        'chat.1.chatUi.chatPostReadyToSend': addMessage,
        'chat.1.chatUi.chatStellarDataConfirm': onDataConfirm,
        'chat.1.chatUi.chatStellarDataError': onDataError,
      },
      incomingCallMap: {
        'chat.1.chatUi.chatStellarDone': onHideConfirm,
        'chat.1.chatUi.chatStellarShowConfirm': onShowConfirm,
      },
      params: {
        ...ephemeralData,
        body: text.stringValue(),
        clientPrev,
        conversationID: Types.keyToConversationID(conversationIDKey),
        identifyBehavior: getIdentifyBehavior(state, conversationIDKey),
        outboxID,
        tlfName,
        tlfPublic: false,
      },
      waitingKey: Constants.waitingKeyPost,
    })
  logger.info('[MessageSend] success')
  } catch() {
  logger.info('[MessageSend] error')
  }

    // Do some logging to track down the root cause of a bug causing
    // messages to not send. Do this after creating the objects above to
    // narrow down the places where the action can possibly stop.
    logger.info('[MessageSend]', 'non-empty text?', text.stringValue().length > 0)

    // We need to put an addMessage ahead of postText in case we get new activity on that outboxID before the
    // the action to add the pending message fires. This would cause a pending message to be stuck
    // (with a duplicate sent message in there too).
    //
    // We put the addMessage on the back in case the service provides chat thread data in between the
    // addMessage and postText action. upgradeMessage should be a no-op in the case that the message
    // that is in the store on the outboxID has been sent.
    yield Saga.sequentially(addMessage())
    stellarConfirmWindowResponse = null
}

let stellarConfirmWindowResponse = null

const confirmScreenResponse = (_, action) => {
  stellarConfirmWindowResponse && stellarConfirmWindowResponse.result(action.payload.accept)
  stellarConfirmWindowResponse = null
}

function * previewConversationAfterFindExisting = (
  results, users
) => {
  // still looking for this result?
  if (
    // If action.type === Chat2Gen.setPendingConversationUsers, then
    // we know that fromSearch is true and participants is non-empty
    // (see previewConversationFindExisting).
    action.type === Chat2Gen.setPendingConversationUsers &&
    !Constants.getMeta(state, Constants.pendingConversationIDKey)
      .participants.toSet()
      .equals(I.Set(users))
  ) {
    console.log('Ignoring old preview find due to participant mismatch')
    return
  }

  let existingConversationIDKey

  const isTeam =
    action.type === Chat2Gen.previewConversation && (action.payload.teamname || action.payload.channelname)
  if (action.type === Chat2Gen.previewConversation && action.payload.conversationIDKey) {
    existingConversationIDKey = action.payload.conversationIDKey
  } else if (results && results.conversations && results.conversations.length > 0) {
    // Even if we find an existing conversation lets put it into the pending state so its on top always, makes the UX simpler and better to see it selected
    // and allows quoting privately to work nicely
    existingConversationIDKey = Types.conversationIDToKey(results.conversations[0].info.id)

    // If we get a conversationIDKey we don't know about (maybe an empty convo) lets treat it as not being found so we can go through the create flow
    // if it's a team avoid the flow and just preview & select the channel
    if (
      !isTeam &&
      existingConversationIDKey &&
      Constants.getMeta(state, existingConversationIDKey).conversationIDKey === Constants.noConversationIDKey
    ) {
      existingConversationIDKey = Constants.noConversationIDKey
    }
  }

  // If we're previewing a team conversation we want to actually make an rpc call and add it to the inbox
  if (isTeam) {
    if (!existingConversationIDKey || existingConversationIDKey === Constants.noConversationIDKey) {
      throw new Error('Tried to preview a non-existant channel?')
    }
    yield Saga.callUntyped(RPCChatTypes.localPreviewConversationByIDLocalRpcPromise, {
        convID: Types.keyToConversationID(existingConversationIDKey),
      })
      yield Saga.put(
        Chat2Gen.createSelectConversation({
          conversationIDKey: existingConversationIDKey,
          reason: 'previewResolved',
        })
      )
      yield Saga.put(Chat2Gen.createNavigateToThread())
  } else {
    yield Saga.put(
        Chat2Gen.createSetPendingConversationExistingConversationIDKey({
          conversationIDKey: existingConversationIDKey || Constants.noConversationIDKey,
        })
      )
      yield Saga.put(Chat2Gen.createSetPendingConversationUsers({fromSearch: false, users}))
      yield Saga.put(Chat2Gen.createNavigateToThread())
  }
}

// Start a conversation, or select an existing one
function * previewConversationFindExisting ( state, action)  {
  let participants
  let teamname
  let channelname
  let conversationIDKey
  if (action.type === Chat2Gen.previewConversation) {
    participants = action.payload.participants
    teamname = action.payload.teamname
    channelname = action.payload.channelname || 'general'
    conversationIDKey = action.payload.conversationIDKey
  } else if (action.type === Chat2Gen.setPendingConversationUsers) {
    if (!action.payload.fromSearch) {
      return
    }
    participants = action.payload.users
    if (!participants.length) {
      yield Saga.put(
        Chat2Gen.createSetPendingConversationExistingConversationIDKey({
          conversationIDKey: Constants.noConversationIDKey,
        })
      )
      return
    }
  }
  const you = state.config.username || ''

  let params
  let users
  let setUsers

  // we handled participants or teams
  if (participants) {
    const toFind = I.Set(participants).add(you)
    params = {tlfName: toFind.join(',')}
    users = I.Set(participants)
      .subtract([you])
      .toArray()
    setUsers = Saga.put(Chat2Gen.createSetPendingConversationUsers({fromSearch: false, users}))
  } else if (teamname) {
    params = {
      membersType: RPCChatTypes.commonConversationMembersType.team,
      tlfName: teamname,
      topicName: channelname,
    }
  } else if (conversationIDKey) {
    // we can skip the call if we have a conversationid already
  } else {
    throw new Error('Start conversation called w/ no participants or teamname')
  }

  yield Saga.put(
    Chat2Gen.createSetPendingConversationExistingConversationIDKey({
      conversationIDKey: Constants.pendingWaitingConversationIDKey,
    })
  )

  if (conversationIDKey) {
    const results = yield Saga.callUntyped(RPCChatTypes.localFindConversationsLocalRpcPromise, {
        identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
        membersType: RPCChatTypes.commonConversationMembersType.impteamnative,
        oneChatPerTLF: true,
        topicName: '',
        topicType: RPCChatTypes.commonTopicType.chat,
        visibility: RPCTypes.commonTLFVisibility.private,
        ...params,
      })
    yield * previewConversationAfterFindExisting(results, users)
  }
}

const startupInboxLoad = (state) =>
  state.config.username ? Chat2Gen.createInboxRefresh({reason: 'bootstrap'}) : undefined

const changeSelectedConversation = (state, action) => {
  const selected = Constants.getSelectedConversation(state)
  switch (action.type) {
    case Chat2Gen.setPendingMode: {
      if (action.payload.pendingMode === 'newChat') {
      } else if (action.payload.pendingMode !== 'none') {
        return [
          Chat2Gen.createSelectConversation({
            conversationIDKey: Constants.pendingConversationIDKey,
            reason: 'setPendingMode',
          }),
          navigateToThreadRoute,
        ]
      } else if (action.payload.noneDestination === 'inbox') {
        return Chat2Gen.createNavigateToInbox({findNewConversation: true})
      } else if (action.payload.noneDestination === 'thread') {
        // don't allow check of isValidConversationIDKey
        return navigateToThreadRoute
      }
      break
    }
    case Chat2Gen.messageSend: // fallthrough
    case Chat2Gen.attachmentsUpload:
      // Sent into a resolved pending conversation? Select the resolved one
      if (selected === Constants.pendingConversationIDKey) {
        const resolvedPendingConversationIDKey = Constants.getResolvedPendingConversationIDKey(state)
        if (resolvedPendingConversationIDKey !== Constants.noConversationIDKey) {
          return Chat2Gen.createSelectConversation({
            conversationIDKey: resolvedPendingConversationIDKey,
            reason: 'sendingToPending',
          })
        }
      }
  }

  if (!isMobile) {
    return _maybeAutoselectNewestConversation(state, action, state)
  }
}

const _maybeAutoselectNewestConversation = (state, action) => {
  // If there is a team we should avoid when selecting a new conversation (e.g.
  // on team leave) put the name in `avoidTeam` and `isEligibleConvo` below will
  // take it into account
  let avoidTeam = ''
  if (action.type === TeamsGen.leaveTeam) {
    avoidTeam = action.payload.teamname
  }
  let selected = Constants.getSelectedConversation(state)
  const selectedMeta = state.chat2.metaMap.get(selected)
  if (!selectedMeta) {
    selected = Constants.noConversationIDKey
  }
  if (action.type === Chat2Gen.metaDelete) {
    if (!action.payload.selectSomethingElse) {
      return
    }
    // only do this if we blocked the current conversation
    if (selected !== Constants.noConversationIDKey && selected !== action.payload.conversationIDKey) {
      return
    }
    // only select something if we're leaving a pending conversation
  } else if (action.type === Chat2Gen.setPendingMode) {
    if (action.payload.pendingMode !== 'none') {
      return
    }
  }

  if (action.type === Chat2Gen.metasReceived) {
    // If we have new activity, don't switch to it unless no convo was selected
    if (selected !== Constants.noConversationIDKey) {
      return
    }
  } else if (action.type === Chat2Gen.setPendingMode) {
    if (Constants.isValidConversationIDKey(selected)) {
      return
    }
  } else if (
    (action.type === Chat2Gen.leaveConversation || action.type === Chat2Gen.blockConversation) &&
    action.payload.conversationIDKey === selected
  ) {
    // Intentional fall-through -- force select a new one
  } else if (
    Constants.isValidConversationIDKey(selected) &&
    (!avoidTeam || (selectedMeta && selectedMeta.teamname !== avoidTeam))
  ) {
    // Stay with our existing convo if it was not empty or pending, or the
    // selected convo already doesn't belong to the team we're trying to switch
    // away from
    return
  }

  const isEligibleConvo = meta => {
    if (meta.teamType === 'big') {
      // Don't select a big team channel
      return false
    }
    if (avoidTeam && meta.teamname === avoidTeam) {
      // We just left this team, don't select a convo from it
      return false
    }
    return true
  }

  // If we got here we're auto selecting the newest convo
  const meta = state.chat2.metaMap.maxBy(meta => (isEligibleConvo(meta) ? meta.timestamp : 0))

  if (meta) {
    return Chat2Gen.createSelectConversation({
      conversationIDKey: meta.conversationIDKey,
      reason: 'findNewestConversation',
    })
  } else if (avoidTeam) {
    // No conversations besides in the team we're trying to avoid. Select
    // nothing
    logger.info(
      `AutoselectNewestConversation: no eligible conversations left in inbox (no conversations outside of team we're avoiding); selecting nothing`
    )
    return Chat2Gen.createSelectConversation({
      conversationIDKey: Constants.noConversationIDKey,
      reason: 'clearSelected',
    })
  }
}

const openFolder = (state, action) => {
  const meta = Constants.getMeta(state, action.payload.conversationIDKey)
  const path = FsTypes.stringToPath(
    meta.teamType !== 'adhoc'
      ? teamFolder(meta.teamname)
      : privateFolderWithUsers(meta.participants.toArray())
  )
  return FsGen.createOpenPathInFilesTab({path})
}

const getRecommendations = ( state, action) => {
  if (
    action.type === Chat2Gen.selectConversation &&
    action.payload.conversationIDKey !== Constants.pendingConversationIDKey
  ) {
    return
  }

  const meta = Constants.getMeta(state, Constants.pendingConversationIDKey)
  if (meta.participants.isEmpty()) {
    return SearchGen.createSearchSuggestions({searchKey: 'chatSearch'})
  }
}

const clearSearchResults = () =>
  SearchGen.createClearSearchResults({searchKey: 'chatSearch'})

const updatePendingParticipants = (
  state,
  action
) => {
  let users
  if (action.type === Chat2Gen.setPendingMode) {
    // Ignore the pendingMode changes other than the clear
    if (action.payload.pendingMode !== 'none') {
      return
    }
    users = []
  } else {
    users = action.payload.userInputItemIds || []
  }

  return [
    Chat2Gen.createSetPendingConversationUsers({fromSearch: true, users})
    SearchGen.createSetUserInputItems({searchKey: 'chatSearch', searchResults: users})
  ]
}

function* downloadAttachment(fileName: string, message: Types.Message) {
  try {
    const conversationIDKey = message.conversationIDKey
    const ordinal = message.ordinal
    let lastRatioSent = -1 // force the first update to show no matter what
    const onDownloadProgress = ({bytesComplete, bytesTotal}) => {
      const ratio = bytesComplete / bytesTotal
      // Don't spam ourselves with updates
      if (ratio - lastRatioSent > 0.05) {
        lastRatioSent = ratio
        return Saga.put(
          Chat2Gen.createAttachmentLoading({conversationIDKey, isPreview: false, ordinal, ratio})
        )
      }
    }

    const rpcRes: RPCChatTypes.DownloadFileAttachmentLocalRes = yield RPCChatTypes.localDownloadFileAttachmentLocalRpcSaga(
      {
        incomingCallMap: {
          'chat.1.chatUi.chatAttachmentDownloadDone': () => {},
          'chat.1.chatUi.chatAttachmentDownloadProgress': onDownloadProgress,
          'chat.1.chatUi.chatAttachmentDownloadStart': () => {},
        },
        params: {
          conversationID: Types.keyToConversationID(conversationIDKey),
          filename: fileName,
          identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
          messageID: message.id,
          preview: false,
        },
      }
    )
    yield Saga.put(Chat2Gen.createAttachmentDownloaded({message, path: fileName}))
    return rpcRes.filename
  } catch (e) {}
  return fileName
}

// Download an attachment to your device
function* attachmentDownload(_, action) {
  const {message} = action.payload

  if (message.type !== 'attachment') {
    throw new Error('Trying to download missing / incorrect message?')
  }

  // already downloaded?
  if (message.downloadPath) {
    logger.warn('Attachment already downloaded')
    return
  }

  // Download it
  const destPath = yield* Saga.callPromise(downloadFilePath, message.fileName)
  yield Saga.callUntyped(downloadAttachment, destPath, message)
}

function* attachmentFullscreenNext  (state, action) {
    const {conversationIDKey, messageID, backInTime} = action.payload
    const blankMessage = Constants.makeMessageAttachment({})
    if (conversationIDKey === blankMessage.conversationIDKey) {
      return
    }
    const currentFullscreen = state.chat2.attachmentFullscreenMessage || blankMessage
    yield Saga.put(Chat2Gen.createAttachmentFullscreenSelection({message: blankMessage}))
    const nextAttachmentRes = yield* Saga.callPromise(
      RPCChatTypes.localGetNextAttachmentMessageLocalRpcPromise,
      {
        assetTypes: [RPCChatTypes.commonAssetMetadataType.image, RPCChatTypes.commonAssetMetadataType.video],
        backInTime,
        convID: Types.keyToConversationID(conversationIDKey),
        identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
        messageID,
      }
    )

    let nextMsg = currentFullscreen
    if (nextAttachmentRes.message) {
      const uiMsg = Constants.uiMessageToMessage(state, conversationIDKey, nextAttachmentRes.message)
      if (uiMsg) {
        nextMsg = uiMsg
      }
    }
    yield Saga.put(Chat2Gen.createAttachmentFullscreenSelection({message: nextMsg}))
  }

  const attachmentPreviewSelect(_, action) => {
  const message = action.payload.message
  if (Constants.isVideoAttachment(message)) {
    // Start up the fullscreen video view
      return RouteTreeGen.createNavigateAppend({
        path: [
          {
            props: {conversationIDKey: message.conversationIDKey, ordinal: message.ordinal},
            selected: 'attachmentVideoFullscreen',
          },
        ],
      })
  } else {
    return [
      Chat2Gen.createAttachmentFullscreenSelection({ message, }),
      RouteTreeGen.createNavigateAppend({
        path: [
          {
            props: {},
            selected: 'attachmentFullscreen',
          },
        ],
      })
    ]
  }
}

// Handle an image pasted into a conversation
const attachmentPasted = (_, action)=> {
  const {conversationIDKey, data} = action.payload
  const outboxID = Constants.generateOutboxID()
  RPCChatTypes.localMakeUploadTempFileRpcPromise({
    data,
    filename: 'paste.png',
    outboxID,
  }).then(path =>  {
  const pathAndOutboxIDs = [
    {
      outboxID,
      path,
    },
  ]
  return RouteTreeGen.createNavigateAppend({
      path: [{props: {conversationIDKey, pathAndOutboxIDs}, selected: 'attachmentGetTitles'}],
    })
  })
}

// Upload an attachment
function* attachmentsUpload(state, action) {
  const {conversationIDKey, paths, titles} = action.payload
  const meta = state.chat2.metaMap.get(conversationIDKey)
  if (!meta) {
    logger.warn('Missing meta for attachment upload', conversationIDKey)
    return
  }
  const clientPrev = Constants.getClientPrev(state, conversationIDKey)
  // disable sending exploding messages if flag is false
  const ephemeralLifetime = Constants.getConversationExplodingMode(state, conversationIDKey)
  const ephemeralData = ephemeralLifetime !== 0 ? {ephemeralLifetime} : {}

  // Post initial messages to get the upload in the outbox, and to also get the outbox IDs
  // These messages will not send until the upload has both been started and completed.
  const messageResults: Array<?RPCChatTypes.PostLocalNonblockRes> = yield Saga.sequentially(
    paths.map((p, i) =>
      Saga.callUntyped(RPCChatTypes.localPostFileAttachmentMessageLocalNonblockRpcPromise, {
        ...ephemeralData,
        clientPrev,
        convID: Types.keyToConversationID(conversationIDKey),
        filename: p.path,
        identifyBehavior: getIdentifyBehavior(state, conversationIDKey),
        metadata: Buffer.from([]),
        outboxID: p.outboxID,
        title: titles[i],
        tlfName: meta.tlfname,
        visibility: RPCTypes.commonTLFVisibility.private,
      })
    )
  )
  const outboxIDs = messageResults.reduce((obids, r) => {
    if (r) {
      obids.push(r.outboxID)
    }
    return obids
  }, [])
  if (outboxIDs.length === 0) {
    logger.info('all outbox IDs filtered on null results')
    return
  }

  // Make the previews
  const previews: Array<?RPCChatTypes.MakePreviewRes> = yield Saga.sequentially(
    paths.map((p, i) =>
      Saga.callUntyped(RPCChatTypes.localMakePreviewRpcPromise, {
        filename: p.path,
        outboxID: outboxIDs[i],
      })
    )
  )

  // Collect preview information
  const previewURLs = previews.map(preview =>
    preview &&
    preview.location &&
    preview.location.ltyp === RPCChatTypes.localPreviewLocationTyp.url &&
    preview.location.url
      ? preview.location.url
      : ''
  )
  const previewSpecs = previews.map(preview =>
    Constants.previewSpecs(preview && preview.metadata, preview && preview.baseMetadata)
  )

  let lastOrdinal = null
  const messages = outboxIDs.map((o, i) => {
    const m = Constants.makePendingAttachmentMessage(
      state,
      conversationIDKey,
      titles[i],
      FsTypes.getLocalPathName(paths[i].path),
      previewURLs[i],
      previewSpecs[i],
      Types.rpcOutboxIDToOutboxID(outboxIDs[i]),
      lastOrdinal,
      null,
      ephemeralLifetime
    )
    lastOrdinal = Constants.nextFractionalOrdinal(m.ordinal)
    return m
  })
  yield Saga.put(
    Chat2Gen.createMessagesAdd({
      context: {type: 'sent'},
      messages,
    })
  )
  yield Saga.sequentially(
    paths.map((path, i) =>
      Saga.callUntyped(RPCChatTypes.localPostFileAttachmentUploadLocalNonblockRpcPromise, {
        callerPreview: previews[i],
        convID: Types.keyToConversationID(conversationIDKey),
        filename: path.path,
        identifyBehavior: getIdentifyBehavior(state, conversationIDKey),
        metadata: Buffer.from([]),
        outboxID: outboxIDs[i],
        title: titles[i],
      })
    )
  )
}

// Tell service we're typing
const sendTyping = (_, action) => {
  const {conversationIDKey, text} = action.payload
  return RPCChatTypes.localUpdateTypingRpcPromise({
    conversationID: Types.keyToConversationID(conversationIDKey),
    text: text.stringValue(),
  })
}

// Implicit teams w/ reset users we can invite them back in or chat w/o them
const resetChatWithoutThem = (state, action) => {
  const {conversationIDKey} = action.payload
  const meta = Constants.getMeta(state, conversationIDKey)
  // remove all bad people
  const goodParticipants = meta.participants.toSet().subtract(meta.resetParticipants)
  return Chat2Gen.createPreviewConversation({
      participants: goodParticipants.toArray(),
      reason: 'resetChatWithoutThem',
    })
}

// let them back in after they reset
const resetLetThemIn = (_, action) => RPCChatTypes.localAddTeamMemberAfterResetRpcPromise({
    convID: Types.keyToConversationID(action.payload.conversationIDKey),
    username: action.payload.username,
  })

const markThreadAsRead = ( state, action) => {
  const conversationIDKey = Constants.getSelectedConversation(state)

  if (!conversationIDKey) {
    logger.info('marking read bail on no selected conversation')
    return
  }
  if (conversationIDKey === Constants.pendingConversationIDKey) {
    logger.info('marking read bail on pending conversation')
    return
  }

  const meta = state.chat2.metaMap.get(conversationIDKey)
  if (!meta) {
    logger.info('marking read bail on not in meta list. preview?')
    return
  }

  if (action.type === Chat2Gen.markInitiallyLoadedThreadAsRead) {
    if (action.payload.conversationIDKey !== conversationIDKey) {
      logger.info('marking read bail on not looking at this thread anymore?')
      return
    }
  }

  if (!Constants.isUserActivelyLookingAtThisThread(state, conversationIDKey)) {
    logger.info('marking read bail on not looking at this thread')
    return
  }

  let message
  const mmap = state.chat2.messageMap.get(conversationIDKey)
  if (mmap) {
    const ordinals = Constants.getMessageOrdinals(state, conversationIDKey)
    const ordinal = ordinals.findLast(o => {
      const m = mmap.get(o)
      return m && !!m.id
    })
    message = mmap.get(ordinal)
  }

  const readMsgID = message ? (message.id > meta.maxMsgID ? message.id : meta.maxMsgID) : meta.maxMsgID
  logger.info(`marking read messages ${conversationIDKey} ${readMsgID}`)
  return RPCChatTypes.localMarkAsReadLocalRpcPromise({
    conversationID: Types.keyToConversationID(conversationIDKey),
    msgID: readMsgID,
  })
}

// Delete a message and any older
const deleteMessageHistory = (state, action) => {
  const {conversationIDKey} = action.payload
  const meta = Constants.getMeta(state, conversationIDKey)

  if (!meta.tlfname) {
    logger.warn('Deleting message history for non-existent TLF:')
    return
  }

    return RPCChatTypes.localPostDeleteHistoryByAgeRpcPromise( {
    age: 0,
    conversationID: Types.keyToConversationID(conversationIDKey),
    identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
    tlfName: meta.tlfname,
    tlfPublic: false,
  }
    )
}

// Get the rights a user has on certain actions in a team
const loadCanUserPerform = (state, action) => {
  const {conversationIDKey} = action.payload
  const meta = Constants.getMeta(state, conversationIDKey)
  const teamname = meta.teamname
  if (!teamname) {
    return
  }
  if (!hasCanPerform(state, teamname)) {
    return TeamsGen.createGetTeamOperations({teamname})
  }
}

// Helpers to nav you to the right place
const navigateToInbox = ( state, action) => {
  if (action.type === Chat2Gen.leaveConversation && action.payload.dontNavigateToInbox) {
    return
  }
  const resetRouteAction = RouteTreeGen.createNavigateTo({path: [{props: {}, selected: Tabs.chatTab}, {props: {}, selected: null}]})
  if (action.type === TeamsGen.leaveTeam || action.type === TeamsGen.leftTeam) {
    const {context, teamname} = action.payload
    switch (action.type) {
      case TeamsGen.leaveTeam:
        if (context !== 'chat' && Constants.isTeamConversationSelected(state, teamname)) {
          // If we're leaving a team from somewhere else and we have a team convo
          // selected, reset the chat tab to the root
          logger.info(`chat:navigateToInbox resetting chat tab nav stack to root because of leaveTeam`)
          return RouteTreeGen.createNavigateTo({parentPath: [Tabs.chatTab], path: []})
        }
        break
      case TeamsGen.leftTeam:
        if (context === 'chat') {
          // If we've left a team from the chat tab indiscriminately navigate to
          // the tab root
          logger.info(`chat:navigateToInbox navigating to cleared chat routes because of leftTeam`)
          return resetRouteAction
        }
    }
    return
  }
  const actions = [resetRouteAction]
  if (action.type === Chat2Gen.navigateToInbox && action.payload.findNewConversation && !isMobile) {
    actions.push(_maybeAutoselectNewestConversation(action, state))
  }
  return actions
}

// Unchecked version of Chat2Gen.createNavigateToThread() --
// Saga.put() this if you want to select the pending conversation
// (which doesn't count as valid).
const navigateToThreadRoute = RouteTreeGen.createNavigateTo({path: Constants.threadRoute})

const navigateToThread = (state, action) => {
  if (!Constants.isValidConversationIDKey(state.chat2.selectedConversation)) {
    console.log('Skip nav to thread on invalid conversation')
    return
  }
  return navigateToThreadRoute
}

const mobileNavigateOnSelect = (state, action) => {
  if (Constants.isValidConversationIDKey(action.payload.conversationIDKey)) {
    return navigateToThreadRoute
  }
}

const mobileChangeSelection = state => {
  const routePath = getPath(state.routeTree.routeState)
  const inboxSelected = routePath.size === 1 && routePath.get(0) === Tabs.chatTab
  if (inboxSelected) {
    return Chat2Gen.createSelectConversation({
      conversationIDKey: Constants.noConversationIDKey,
      reason: 'clearSelected',
    })
  }
}

// Native share sheet for attachments
function* mobileMessageAttachmentShare(state, action) {
  const {conversationIDKey, ordinal} = action.payload
  let state = yield* Saga.selectState()
  let message = Constants.getMessage(state, conversationIDKey, ordinal)
  if (!message || message.type !== 'attachment') {
    throw new Error('Invalid share message')
  }
  const fileName = yield* downloadAttachment('', message)
  try {
    yield* Saga.callPromise(showShareActionSheetFromFile, fileName, message.fileType)
  } catch (e) {
    logger.error('Failed to share attachment: ' + JSON.stringify(e))
  }
}

// Native save to camera roll
function* mobileMessageAttachmentSave(state, action) {
  const {conversationIDKey, ordinal} = action.payload
  let message = Constants.getMessage(state, conversationIDKey, ordinal)
  if (!message || message.type !== 'attachment') {
    throw new Error('Invalid share message')
  }
  const fileName = yield* downloadAttachment('', message)
  yield Saga.put(
    Chat2Gen.createAttachmentMobileSave({
      conversationIDKey: message.conversationIDKey,
      ordinal: message.ordinal,
    })
  )
  try {
    logger.info('Trying to save chat attachment to camera roll')
    yield* Saga.callPromise(saveAttachmentToCameraRoll, fileName, message.fileType)
  } catch (err) {
    logger.error('Failed to save attachment: ' + err)
    throw new Error('Failed to save attachment: ' + err)
  }
  yield Saga.put(
    Chat2Gen.createAttachmentMobileSaved({
      conversationIDKey: message.conversationIDKey,
      ordinal: message.ordinal,
    })
  )
}

const joinConversation = (_, action) =>
    RPCChatTypes.localJoinConversationByIDLocalRpcPromise(
    { convID: Types.keyToConversationID(action.payload.conversationIDKey), },
    Constants.waitingKeyJoinConversation
  )

const leaveConversation = (_, action) =>
  RPCChatTypes.localLeaveConversationLocalRpcPromise( {
    convID: Types.keyToConversationID(action.payload.conversationIDKey),
  })

const muteConversation = (_, action) =>
  RPCChatTypes.localSetConversationStatusLocalRpcPromise( {
    conversationID: Types.keyToConversationID(action.payload.conversationIDKey),
    identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
    status: action.payload.muted
      ? RPCChatTypes.commonConversationStatus.muted
      : RPCChatTypes.commonConversationStatus.unfiled,
  })

const updateNotificationSettings = (_, action) =>
  RPCChatTypes.localSetAppNotificationSettingsLocalRpcPromise( {
    channelWide: action.payload.notificationsGlobalIgnoreMentions,
    convID: Types.keyToConversationID(action.payload.conversationIDKey),
    settings: [
      {
        deviceType: RPCTypes.commonDeviceType.desktop,
        enabled: action.payload.notificationsDesktop === 'onWhenAtMentioned',
        kind: RPCChatTypes.commonNotificationKind.atmention,
      },
      {
        deviceType: RPCTypes.commonDeviceType.desktop,
        enabled: action.payload.notificationsDesktop === 'onAnyActivity',
        kind: RPCChatTypes.commonNotificationKind.generic,
      },
      {
        deviceType: RPCTypes.commonDeviceType.mobile,
        enabled: action.payload.notificationsMobile === 'onWhenAtMentioned',
        kind: RPCChatTypes.commonNotificationKind.atmention,
      },
      {
        deviceType: RPCTypes.commonDeviceType.mobile,
        enabled: action.payload.notificationsMobile === 'onAnyActivity',
        kind: RPCChatTypes.commonNotificationKind.generic,
      },
    ],
  })

function*  blockConversation  (_, action) {
    yield Saga.put(Chat2Gen.createNavigateToInbox({findNewConversation: true}))
    yield Saga.callUntyped(RPCChatTypes.localSetConversationStatusLocalRpcPromise, {
      conversationID: Types.keyToConversationID(action.payload.conversationIDKey),
      identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
      status: action.payload.reportUser
        ? RPCChatTypes.commonConversationStatus.reported
        : RPCChatTypes.commonConversationStatus.blocked,
    })

  }

const setConvRetentionPolicy = (_, action) => {
  const {conversationIDKey, policy} = action.payload
  const convID = Types.keyToConversationID(conversationIDKey)
  let servicePolicy: ?RPCChatTypes.RetentionPolicy
  let ret
  try {
    servicePolicy = retentionPolicyToServiceRetentionPolicy(policy)
  } catch (err) {
    // should never happen
    logger.error(`Unable to parse retention policy: ${err.message}`)
    throw err
  } finally {
    if (servicePolicy) {
      return RPCChatTypes.localSetConvRetentionLocalRpcPromise({
        convID,
        policy: servicePolicy,
      })
    }
  }
}

const changePendingMode = ( state, action
) => {
  switch (action.type) {
    case Chat2Gen.previewConversation:
      // We decided to make a team instead of start a convo, so no resolution will take place
      if (action.payload.reason === 'convertAdHoc') {
        return Chat2Gen.createSetPendingMode({noneDestination: 'inbox', pendingMode: 'none'})
      }
      // We're selecting a team so we never want to show the row, we'll instead make the rpc call to add it to the inbox
      if (action.payload.teamname || action.payload.channelname) {
        return Chat2Gen.createSetPendingMode({pendingMode: 'none'})
      } else {
        // Otherwise, we're starting a chat with some users.
        return Chat2Gen.createSetPendingMode({
            pendingMode: action.payload.reason === 'fromAReset' ? 'startingFromAReset' : 'fixedSetOfUsers',
          })
      }
    case Chat2Gen.selectConversation: {
      if (state.chat2.pendingMode === 'none') {
        return
      }
      if (
        action.payload.conversationIDKey === Constants.pendingConversationIDKey ||
        action.payload.conversationIDKey === Constants.pendingWaitingConversationIDKey
      ) {
        return
      }

      // Selected another conversation and the pending users are empty
      const meta = Constants.getMeta(state, Constants.pendingConversationIDKey)
      if (meta.participants.isEmpty()) {
        return Chat2Gen.createSetPendingMode({pendingMode: 'none'})
      }

      // Selected the resolved pending conversation? Exit pendingMode
      if (meta.conversationIDKey === action.payload.conversationIDKey) {
        return Chat2Gen.createSetPendingMode({pendingMode: 'none'})
      }
    }
  }
}

// TODO create a conversation row that has a pending tag applied to it
const createPendingConversation = function*(users: Array<string>) {
  yield Saga.put(Chat2Gen.createSetPendingMode({pendingMode: 'newTeamBuilding'}))
  yield Saga.put(Chat2Gen.createSetPendingStatus({pendingStatus: 'none'}))
  yield Saga.put(Chat2Gen.createSetPendingConversationUsers({fromSearch: true, users}))
}

const removePendingConversation = function*() {
  yield Saga.put(Chat2Gen.createSetPendingMode({noneDestination: 'thread', pendingMode: 'none'}))
}

// TODO This will break if you try to make 2 new conversations at the same time because there is
// only one pending conversation state.
// The fix involves being able to make multiple pending conversations
function * createConversation2  (state, action) {
  if (!flags.newTeamBuildingForChat) {
    return
  }
    const username = state.config.username
    if (!username) {
      logger.error('Making a convo while logged out?')
      return
    }

    const {
      payload: {participants},
    } = action
    yield createPendingConversation(participants)
    try {
      const result: RPCChatTypes.NewConversationLocalRes = yield* Saga.callPromise(
        RPCChatTypes.localNewConversationLocalRpcPromise,
        {
          identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
          membersType: RPCChatTypes.commonConversationMembersType.impteamnative,
          tlfName: I.Set([username])
            .concat(action.payload.participants)
            .join(','),
          tlfVisibility: RPCTypes.commonTLFVisibility.private,
          topicType: RPCChatTypes.commonTopicType.chat,
        },
        Constants.waitingKeyCreating
      )

      const conversationIDKey = Types.conversationIDToKey(result.conv.info.id)
      if (!conversationIDKey) {
        logger.warn("Couldn't make a new conversation?")
      } else {
        yield Saga.put(Chat2Gen.createSelectConversation({conversationIDKey, reason: 'justCreated'}))
      }
    } catch (e) {
      logger.error(`Failed to create new conversation: ${e.message}`)
    }

    yield removePendingConversation()
}

const createConversation = (state, action) => {
  if (flags.newTeamBuildingForChat) {
    return
  }
  const username = state.config.username
  if (!username) {
    throw new Error('Making a convo while logged out?')
  }
  return RPCChatTypes.localNewConversationLocalRpcPromise(
    {
      identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
      membersType: RPCChatTypes.commonConversationMembersType.impteamnative,
      tlfName: I.Set([username])
        .concat(action.payload.participants)
        .join(','),
      tlfVisibility: RPCTypes.commonTLFVisibility.private,
      topicType: RPCChatTypes.commonTopicType.chat,
    },
    Constants.waitingKeyCreating
  ).then(result => {
  const conversationIDKey = Types.conversationIDToKey(result.conv.info.id)
  if (!conversationIDKey) {
    logger.warn("Couldn't make a new conversation?")
    return
  }
  return [
    Chat2Gen.createSelectConversation({conversationIDKey, reason: 'justCreated'}),
    Chat2Gen.createSetPendingMode({noneDestination: 'thread', pendingMode: 'none'}),
  ]
  }).catch(() => Chat2Gen.createSetPendingStatus({pendingStatus: 'failed'}))
}

// don't bug the users with black bars for network errors. chat isn't going to work in general
const ignoreErrors = [
  RPCTypes.constantsStatusCode.scgenericapierror,
  RPCTypes.constantsStatusCode.scapinetworkerror,
  RPCTypes.constantsStatusCode.sctimeout,
]
function * setConvExplodingMode (_, action) {
  const {conversationIDKey, seconds} = action.payload
  logger.info(`Setting exploding mode for conversation ${conversationIDKey} to ${seconds}`)

  // unset a conversation exploding lock for this convo so we accept the new one
  yield Saga.put(Chat2Gen.createSetExplodingModeLock({conversationIDKey, unset: true}))

  const category = Constants.explodingModeGregorKey(conversationIDKey)
  if (seconds === 0) {
    // dismiss the category so we don't leave cruft in the push state
    yield Saga.callUntyped(RPCTypes.gregorDismissCategoryRpcPromise, {category})
  } else {
    // update the category with the exploding time
    try {
      const res = yield Saga.callUntyped(RPCTypes.gregorUpdateCategoryRpcPromise, {
        body: seconds.toString(),
        category,
        dtime: {offset: 0, time: 0},
      })
  const {conversationIDKey, seconds} = action.payload
  if (seconds !== 0) {
    logger.info(`Successfully set exploding mode for conversation ${conversationIDKey} to ${seconds}`)
  } else {
    logger.info(`Successfully unset exploding mode for conversation ${conversationIDKey}`)
  }
    } catch (e) {
  const {conversationIDKey, seconds} = action.payload
  if (seconds !== 0) {
    logger.error(
      `Failed to set exploding mode for conversation ${conversationIDKey} to ${seconds}. Service responded with: ${
        e.message
      }`
    )
  } else {
    logger.error(
      `Failed to unset exploding mode for conversation ${conversationIDKey}. Service responded with: ${
        e.message
      }`
    )
  }
  if (ignoreErrors.includes(e.code)) {
    return
  }
  throw e
    }
  }
}

const handleSeeingExplodingMessages = (_, action) => {
  const gregorState = yield* Saga.callPromise(RPCTypes.gregorGetStateRpcPromise)
  const seenExplodingMessages =
    gregorState.items && gregorState.items.find(i => i.item?.category === Constants.seenExplodingGregorKey)
  let body = Date.now().toString()
  if (seenExplodingMessages) {
    const contents = seenExplodingMessages.item && seenExplodingMessages.item.body.toString()
    if (isNaN(parseInt(contents, 10))) {
      logger.info('handleSeeingExplodingMessages: bad seenExploding item body, updating category')
    } else {
      // do nothing
      return
    }
  }
  return RPCTypes.gregorUpdateCategoryRpcPromise({
    body,
    category: Constants.seenExplodingGregorKey,
    dtime: {offset: 0, time: 0},
  }).then(() => {})
}

function * handleSeeingWallets (_, action)  {
  const gregorState = yield* Saga.callPromise(RPCTypes.gregorGetStateRpcPromise)
  const seenWallets =
    gregorState.items && gregorState.items.some(i => i.item?.category === Constants.seenWalletsGregorKey)
  if (seenWallets) {
    logger.info('handleSeeingWallets: gregor state already think wallets is old; skipping update.')
    return
  }
  try {
    logger.info('handleSeeingWallets: setting seenWalletsGregorKey')
    yield* Saga.callPromise(RPCTypes.gregorUpdateCategoryRpcPromise, {
      body: 'true',
      category: Constants.seenWalletsGregorKey,
      dtime: {offset: 0, time: 0},
    })
    logger.info('handleSeeingWallets: successfully set seenWalletsGregorKey')
  } catch (err) {
    logger.error(
      `handleSeeingWallets: failed to set seenWalletsGregorKey. Local state might not persist on restart. Error: ${
        err.message
      }`
    )
  }
}

const loadStaticConfig = (state: TypedState, action: ConfigGen.DaemonHandshakePayload) =>
  !state.chat2.staticConfig &&
  Saga.sequentially([
    Saga.put(
      ConfigGen.createDaemonHandshakeWait({
        increment: true,
        name: 'chat.loadStatic',
        version: action.payload.version,
      })
    ),
    Saga.callUntyped(function*() {
      const loadAction = yield RPCChatTypes.localGetStaticConfigRpcPromise().then(res => {
        if (!res.deletableByDeleteHistory) {
          logger.error('chat.loadStaticConfig: got no deletableByDeleteHistory in static config')
          return
        }
        const deletableByDeleteHistory = res.deletableByDeleteHistory.reduce((res, type) => {
          const ourTypes = Constants.serviceMessageTypeToMessageTypes(type)
          if (ourTypes) {
            res.push(...ourTypes)
          }
          return res
        }, [])
        return Chat2Gen.createStaticConfigLoaded({
          staticConfig: Constants.makeStaticConfig({
            deletableByDeleteHistory: I.Set(deletableByDeleteHistory),
          }),
        })
      })

      if (loadAction) {
        yield Saga.put(loadAction)
      }
    }),
    Saga.put(
      ConfigGen.createDaemonHandshakeWait({
        increment: false,
        name: 'chat.loadStatic',
        version: action.payload.version,
      })
    ),
  ])

const toggleMessageReaction = (state, action) => {
  // The service translates this to a delete if an identical reaction already exists
  // so we only need to call this RPC to toggle it on & off
  const {conversationIDKey, emoji, ordinal} = action.payload
  if (!emoji) {
    return
  }
  const message = Constants.getMessage(state, conversationIDKey, ordinal)
  if (!message) {
    logger.warn(`toggleMessageReaction: no message found`)
    return
  }
  if ((message.type === 'text' || message.type === 'attachment') && message.exploded) {
    logger.warn(`toggleMessageReaction: message is exploded`)
    return
  }
  const messageID = message.id
  const clientPrev = Constants.getClientPrev(state, conversationIDKey)
  const meta = Constants.getMeta(state, conversationIDKey)
  const outboxID = Constants.generateOutboxID()
  logger.info(`toggleMessageReaction: posting reaction`)
  return RPCChatTypes.localPostReactionNonblockRpcPromise({
      body: emoji,
      clientPrev,
      conversationID: Types.keyToConversationID(conversationIDKey),
      identifyBehavior: getIdentifyBehavior(state, conversationIDKey),
      outboxID,
      supersedes: messageID,
      tlfName: meta.tlfname,
      tlfPublic: false,
  }).finally(() =>
      Chat2Gen.createToggleLocalReaction({
        conversationIDKey,
        emoji,
        targetOrdinal: ordinal,
        username: state.config.username || '',
      })
    )
}

const receivedBadgeState = (state: TypedState, action: NotificationsGen.ReceivedBadgeStatePayload) =>
  Saga.put(Chat2Gen.createBadgesUpdated({conversations: action.payload.badgeState.conversations || []}))

const setMinWriterRole = (action: Chat2Gen.SetMinWriterRolePayload) => {
  const {conversationIDKey, role} = action.payload
  logger.info(`Setting minWriterRole to ${role} for convID ${conversationIDKey}`)
  return Saga.callUntyped(RPCChatTypes.localSetConvMinWriterRoleLocalRpcPromise, {
    convID: Types.keyToConversationID(conversationIDKey),
    role: RPCTypes.teamsTeamRole[role],
  })
}

const unfurlRemove = (state, action) => {
  const {conversationIDKey, messageID} = action.payload
  const meta = state.chat2.metaMap.get(conversationIDKey)
  if (!meta) {
    logger.debug('unfurl remove no meta found, aborting!')
    return
  }
  return RPCChatTypes.localPostDeleteNonblockRpcPromise(
    {
      clientPrev: 0,
      conversationID: Types.keyToConversationID(conversationIDKey),
      identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
      outboxID: null,
      supersedes: messageID,
      tlfName: meta.tlfname,
      tlfPublic: false,
    },
    Constants.waitingKeyDeletePost
  )
}

const unfurlDismissPrompt = (state, action) => {
  const {conversationIDKey, messageID, domain} = action.payload
  return Chat2Gen.createUnfurlTogglePrompt({
      conversationIDKey,
      domain,
      messageID,
      show: false,
    })
}

const unfurlResolvePrompt = (state, action) => {
  const {conversationIDKey, messageID, result} = action.payload
  return RPCChatTypes.localResolveUnfurlPromptRpcPromise({
    convID: Types.keyToConversationID(conversationIDKey),
    identifyBehavior: RPCTypes.tlfKeysTLFIdentifyBehavior.chatGui,
    msgID: Types.messageIDToNumber(messageID),
    result,
  })
}

const openChatFromWidget = ( state, {payload: {conversationIDKey}}) =>
  [
    ConfigGen.createShowMain(),
    RouteTreeGen.createSwitchTo({path: [Tabs.chatTab]}),
    ...(conversationIDKey
      ? [Chat2Gen.createSelectConversation({conversationIDKey, reason: 'inboxSmall'})]
      : []),
  ]

const gregorPushState = (state: TypedState, action: GregorGen.PushStatePayload) => {
  const actions = []
  const items = action.payload.state

  const explodingItems = items.filter(i => i.item.category.startsWith(Constants.explodingModeGregorKeyPrefix))
  if (!explodingItems.length) {
    // No conversations have exploding modes, clear out what is set
    actions.push(Saga.put(Chat2Gen.createUpdateConvExplodingModes({modes: []})))
  } else {
    logger.info('Got push state with some exploding modes')
    const modes = explodingItems.reduce((current, i) => {
      const {category, body} = i.item
      const secondsString = body.toString()
      const seconds = parseInt(secondsString, 10)
      if (isNaN(seconds)) {
        logger.warn(`Got dirty exploding mode ${secondsString} for category ${category}`)
        return current
      }
      const _conversationIDKey = category.substring(Constants.explodingModeGregorKeyPrefix.length)
      const conversationIDKey = Types.stringToConversationIDKey(_conversationIDKey)
      current.push({conversationIDKey, seconds})
      return current
    }, [])
    actions.push(Saga.put(Chat2Gen.createUpdateConvExplodingModes({modes})))
  }

  const seenExploding = items.find(i => i.item.category === Constants.seenExplodingGregorKey)
  let isNew = true
  if (seenExploding) {
    const body = seenExploding.item.body.toString()
    const when = parseInt(body, 10)
    if (!isNaN(when)) {
      isNew = Date.now() - when < Constants.newExplodingGregorOffset
    }
  }
  actions.push(Saga.put(Chat2Gen.createSetExplodingMessagesNew({new: isNew})))

  const seenWallets = items.some(i => i.item.category === Constants.seenWalletsGregorKey)
  if (seenWallets && state.chat2.isWalletsNew) {
    logger.info('chat.gregorPushState: got seenWallets and we thought they were new, updating store.')
    actions.push(Saga.put(Chat2Gen.createSetWalletsOld()))
  }

  return Saga.sequentially(actions)
}

const prepareFulfillRequestForm = (state: TypedState, action: Chat2Gen.PrepareFulfillRequestFormPayload) => {
  const {conversationIDKey, ordinal} = action.payload
  const message = Constants.getMessage(state, conversationIDKey, ordinal)
  if (!message) {
    logger.error(
      `prepareFulfillRequestForm: couldn't find message. convID=${conversationIDKey} ordinal=${Types.ordinalToNumber(
        ordinal
      )}`
    )
    return
  }
  if (message.type !== 'requestPayment') {
    logger.error(
      `prepareFulfillRequestForm: got message with incorrect type '${
        message.type
      }', expected 'requestPayment'. convID=${conversationIDKey} ordinal=${Types.ordinalToNumber(ordinal)}`
    )
    return
  }
  const requestInfo = Constants.getRequestMessageInfo(state, message)
  if (!requestInfo) {
    // This message shouldn't even be rendered; we shouldn't be here, throw error
    throw new Error(
      `Couldn't find request info for message in convID=${conversationIDKey} ordinal=${Types.ordinalToNumber(
        ordinal
      )}`
    )
  }
  return Saga.put(
    WalletsGen.createOpenSendRequestForm({
      amount: requestInfo.amount,
      currency: requestInfo.currencyCode || 'XLM',
      from: WalletTypes.noAccountID,
      recipientType: 'keybaseUser',
      secretNote: message.note,
      to: message.author,
    })
  )
}

function* chat2Saga(): Saga.SagaGenerator<any, any> {
  // Platform specific actions
  if (isMobile) {
    // Push us into the conversation
    yield* Saga.chainAction<Chat2Gen.SelectConversationPayload>(
      Chat2Gen.selectConversation,
      mobileNavigateOnSelect
    )
    yield* Saga.chainGenerator<Chat2Gen.MessageAttachmentNativeSharePayload>(
      Chat2Gen.messageAttachmentNativeShare,
      mobileMessageAttachmentShare
    )
    yield* Saga.chainGenerator<Chat2Gen.MessageAttachmentNativeSavePayload>(
      Chat2Gen.messageAttachmentNativeSave,
      mobileMessageAttachmentSave
    )
    // Unselect the conversation when we go to the inbox
    yield* Saga.chainAction<any>(
      a => typeof a.type === 'string' && a.type.startsWith(RouteTreeGen.typePrefix),
      mobileChangeSelection
    )
  } else {
    yield* Saga.chainGenerator<Chat2Gen.DesktopNotificationPayload>(
      Chat2Gen.desktopNotification,
      desktopNotify
    )
  }

  // Sometimes change the selection
  yield* Saga.chainAction<
    | Chat2Gen.MetasReceivedPayload
    | Chat2Gen.LeaveConversationPayload
    | Chat2Gen.MetaDeletePayload
    | Chat2Gen.SetPendingModePayload
    | Chat2Gen.MessageSendPayload
    | Chat2Gen.AttachmentsUploadPayload
    | Chat2Gen.BlockConversationPayload
    | TeamsGen.LeaveTeamPayload
  >(
    [
      Chat2Gen.metasReceived,
      Chat2Gen.leaveConversation,
      Chat2Gen.metaDelete,
      Chat2Gen.setPendingMode,
      Chat2Gen.messageSend,
      Chat2Gen.attachmentsUpload,
      Chat2Gen.blockConversation,
      TeamsGen.leaveTeam,
    ],
    changeSelectedConversation
  )
  // Refresh the inbox
  yield* Saga.chainGenerator<Chat2Gen.InboxRefreshPayload>(Chat2Gen.inboxRefresh, inboxRefresh)
  // Load teams
  yield* Saga.chainAction<Chat2Gen.MetasReceivedPayload>(Chat2Gen.metasReceived, requestTeamsUnboxing)
  // We've scrolled some new inbox rows into view, queue them up
  yield* Saga.chainAction<Chat2Gen.MetaNeedsUpdatingPayload>(Chat2Gen.metaNeedsUpdating, queueMetaToRequest)
  // We have some items in the queue to process
  yield* Saga.chainAction<Chat2Gen.MetaHandleQueuePayload>(Chat2Gen.metaHandleQueue, requestMeta)

  // Actually try and unbox conversations
  yield* Saga.chainGenerator<Chat2Gen.MetaRequestTrustedPayload | Chat2Gen.SelectConversationPayload>(
    [Chat2Gen.metaRequestTrusted, Chat2Gen.selectConversation],
    unboxRows
  )

  // Load the selected thread
  yield* Saga.chainGenerator<
    | Chat2Gen.SelectConversationPayload
    | Chat2Gen.SetPendingConversationExistingConversationIDKeyPayload
    | Chat2Gen.LoadOlderMessagesDueToScrollPayload
    | Chat2Gen.SetPendingConversationUsersPayload
    | Chat2Gen.MarkConversationsStalePayload
    | Chat2Gen.MetasReceivedPayload
    | ConfigGen.ChangedFocusPayload
  >(
    [
      Chat2Gen.selectConversation,
      Chat2Gen.setPendingConversationExistingConversationIDKey,
      Chat2Gen.loadOlderMessagesDueToScroll,
      Chat2Gen.setPendingConversationUsers,
      Chat2Gen.markConversationsStale,
      Chat2Gen.metasReceived,
      ConfigGen.changedFocus,
    ],
    loadMoreMessages
  )

  yield* Saga.chainAction<Chat2Gen.MessageRetryPayload>(Chat2Gen.messageRetry, messageRetry)
  yield* Saga.chainGenerator<Chat2Gen.MessageSendPayload>(
    Chat2Gen.messageSend,
    messageSend,
  )
  yield* Saga.chainGenerator<Chat2Gen.MessageEditPayload>(Chat2Gen.messageEdit, messageEdit)
  yield* Saga.chainAction<Chat2Gen.MessageEditPayload>(Chat2Gen.messageEdit, clearMessageSetEditing)
  yield* Saga.chainAction<Chat2Gen.MessageDeletePayload>(Chat2Gen.messageDelete, messageDelete)
  yield* Saga.chainAction<Chat2Gen.MessageDeleteHistoryPayload>(
    Chat2Gen.messageDeleteHistory,
    deleteMessageHistory
  )
  yield* Saga.chainAction<Chat2Gen.ConfirmScreenResponsePayload>(
    Chat2Gen.confirmScreenResponse,
    confirmScreenResponse
  )

  yield* Saga.chainAction<Chat2Gen.SelectConversationPayload | Chat2Gen.MessageSendPayload>(
    [Chat2Gen.selectConversation, Chat2Gen.messageSend],
    clearInboxFilter
  )
  yield* Saga.chainAction<Chat2Gen.SelectConversationPayload>(Chat2Gen.selectConversation, loadCanUserPerform)

  // Unfurl
  yield* Saga.chainAction<Chat2Gen.UnfurlResolvePromptPayload>(
    Chat2Gen.unfurlResolvePrompt,
    unfurlResolvePrompt
  )
  yield* Saga.chainAction<Chat2Gen.UnfurlResolvePromptPayload>(
    Chat2Gen.unfurlResolvePrompt,
    unfurlDismissPrompt
  )
  yield* Saga.chainAction<Chat2Gen.UnfurlRemovePayload>(Chat2Gen.unfurlRemove, unfurlRemove)

  yield* Saga.chainGenerator<Chat2Gen.PreviewConversationPayload | Chat2Gen.SetPendingConversationUsersPayload>(
    [Chat2Gen.previewConversation, Chat2Gen.setPendingConversationUsers],
    previewConversationFindExisting,
  )
  yield* Saga.chainAction<Chat2Gen.OpenFolderPayload>(Chat2Gen.openFolder, openFolder)

  // On login lets load the untrusted inbox. This helps make some flows easier
  yield* Saga.chainAction<ConfigGen.LoggedInPayload>(ConfigGen.loggedIn, startupInboxLoad)

  // Search handling
  yield* Saga.chainAction<Chat2Gen.setPendingModePayload | SearchGen.UserInputItemsUpdatedPayload>(
    [Chat2Gen.setPendingMode, SearchConstants.isUserInputItemsUpdated('chatSearch')],
    updatePendingParticipants
  )
  yield* Saga.chainAction<SearchGen.UserInputItemsUpdatedPayload>(
    SearchConstants.isUserInputItemsUpdated('chatSearch'),
    clearSearchResults
  )
  yield* Saga.chainAction<Chat2Gen.SetPendingConversationUsersPayload | Chat2Gen.SelectConversationPayload>(
    [Chat2Gen.setPendingConversationUsers, Chat2Gen.selectConversation],
    getRecommendations
  )

  yield* Saga.chainAction<Chat2Gen.AttachmentPreviewSelectPayload>(
    Chat2Gen.attachmentPreviewSelect,
    attachmentPreviewSelect
  )
  yield* Saga.chainGenerator<Chat2Gen.AttachmentDownloadPayload>(Chat2Gen.attachmentDownload, attachmentDownload)
  yield* Saga.chainGenerator<Chat2Gen.AttachmentsUploadPayload>(Chat2Gen.attachmentsUpload, attachmentsUpload)
  yield* Saga.chainAction<Chat2Gen.AttachmentPastedPayload>(Chat2Gen.attachmentPasted, attachmentPasted)
  yield* Saga.chainGenerator<Chat2Gen.AttachmentFullscreenNextPayload>(
    Chat2Gen.attachmentFullscreenNext,
    attachmentFullscreenNext
  )

  yield* Saga.chainAction<Chat2Gen.SendTypingPayload>(Chat2Gen.sendTyping, sendTyping)
  yield* Saga.chainAction<Chat2Gen.ResetChatWithoutThemPayload>(
    Chat2Gen.resetChatWithoutThem,
    resetChatWithoutThem
  )
  yield* Saga.chainAction<Chat2Gen.ResetLetThemInPayload>(Chat2Gen.resetLetThemIn, resetLetThemIn)

  yield* Saga.chainAction<
    | Chat2Gen.MessagesAddPayload
    | Chat2Gen.SelectConversationPayload
    | Chat2Gen.MarkInitiallyLoadedThreadAsReadPayload
    | Chat2Gen.UpdateReactionsPayload
    | ConfigGen.ChangedFocusPayload
    | RouteTreeGen.Actions
  >(
    [
      Chat2Gen.messagesAdd,
      Chat2Gen.selectConversation,
      Chat2Gen.markInitiallyLoadedThreadAsRead,
      Chat2Gen.updateReactions,
      ConfigGen.changedFocus,
      a => typeof a.type === 'string' && a.type.startsWith(RouteTreeGen.typePrefix),
    ],
    markThreadAsRead
  )

  yield* Saga.chainAction<
    | Chat2Gen.NavigateToInboxPayload
    | Chat2Gen.LeaveConversationPayload
    | TeamsGen.LeaveTeamPayload
    | TeamsGen.LeftTeamPayload
  >(
    [Chat2Gen.navigateToInbox, Chat2Gen.leaveConversation, TeamsGen.leaveTeam, TeamsGen.leftTeam],
    navigateToInbox
  )
  yield* Saga.chainAction<Chat2Gen.NavigateToThreadPayload>(Chat2Gen.navigateToThread, navigateToThread)

  yield* Saga.chainAction<Chat2Gen.JoinConversationPayload>(Chat2Gen.joinConversation, joinConversation)
  yield* Saga.chainAction<Chat2Gen.LeaveConversationPayload>(Chat2Gen.leaveConversation, leaveConversation)

  yield* Saga.chainAction<Chat2Gen.MuteConversationPayload>(Chat2Gen.muteConversation, muteConversation)
  yield* Saga.chainAction<Chat2Gen.UpdateNotificationSettingsPayload>(
    Chat2Gen.updateNotificationSettings,
    updateNotificationSettings
  )
  yield* Saga.chainGenerator<Chat2Gen.BlockConversationPayload>(Chat2Gen.blockConversation, blockConversation)

  yield* Saga.chainAction<Chat2Gen.SetConvRetentionPolicyPayload>(
    Chat2Gen.setConvRetentionPolicy,
    setConvRetentionPolicy
  )
  yield* Saga.chainGenerator<Chat2Gen.MessageReplyPrivatelyPayload>(
    Chat2Gen.messageReplyPrivately,
    messageReplyPrivately
  )
  yield* Saga.chainGenerator<Chat2Gen.CreateConversationPayload>(
    Chat2Gen.createConversation,
    createConversation2
  )
  yield* Saga.chainAction<Chat2Gen.CreateConversationPayload>(
    Chat2Gen.createConversation,
    createConversation,
  )
  yield* Saga.chainAction<Chat2Gen.SelectConversationPayload | Chat2Gen.PreviewConversationPayload>(
    [Chat2Gen.selectConversation, Chat2Gen.previewConversation],
    changePendingMode
  )
  yield* Saga.chainAction<Chat2Gen.OpenChatFromWidgetPayload>(Chat2Gen.openChatFromWidget, openChatFromWidget)

  // Exploding things
  yield* Saga.chainGenerator<Chat2Gen.SetConvExplodingModePayload>(
    Chat2Gen.setConvExplodingMode,
    setConvExplodingMode,
  )
  yield* Saga.chainAction<Chat2Gen.HandleSeeingExplodingMessagesPayload>(
    Chat2Gen.handleSeeingExplodingMessages,
    handleSeeingExplodingMessages
  )
  yield* Saga.chainGenerator<Chat2Gen.HandleSeeingWalletsPayload>(
    Chat2Gen.handleSeeingWallets,
    handleSeeingWallets
  )
  yield* Saga.chainAction<Chat2Gen.ToggleMessageReactionPayload>(
    Chat2Gen.toggleMessageReaction,
    toggleMessageReaction
  )
  yield* Saga.chainAction<ConfigGen.DaemonHandshakePayload>(ConfigGen.daemonHandshake, loadStaticConfig)
  yield* Saga.chainAction<ConfigGen.SetupEngineListenersPayload>(
    ConfigGen.setupEngineListeners,
    setupEngineListeners
  )
  yield* Saga.chainAction<NotificationsGen.ReceivedBadgeStatePayload>(
    NotificationsGen.receivedBadgeState,
    receivedBadgeState
  )
  yield* Saga.chainAction<Chat2Gen.SetMinWriterRolePayload>(Chat2Gen.setMinWriterRole, setMinWriterRole)
  yield* Saga.chainAction<GregorGen.PushStatePayload>(GregorGen.pushState, gregorPushState)
  yield* Saga.spawn(chatTeamBuildingSaga)
  yield* Saga.chainAction<Chat2Gen.PrepareFulfillRequestFormPayload>(
    Chat2Gen.prepareFulfillRequestForm,
    prepareFulfillRequestForm
  )
}

export default chat2Saga
