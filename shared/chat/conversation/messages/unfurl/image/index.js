// @flow
import * as React from 'react'
import * as Kb from '../../../../../common-adapters/index'
import * as Styles from '../../../../../styles'
import {clamp} from 'lodash-es'
import {imgMaxWidth} from '../../attachment/image/image-render'

export type Props = {
  height: number,
  width: number,
  url: string,
  style?: Object,
}

const clampImageSize = ({width = 0, height = 0}, maxSize) =>
  height > width
    ? {
        height: clamp(height || 0, 0, maxSize),
        width: (clamp(height || 0, 0, maxSize) * width) / (height || 1),
      }
    : {
        height: (clamp(width || 0, 0, maxSize) * height) / (width || 1),
        width: clamp(width || 0, 0, maxSize),
      }

class UnfurlImage extends React.Component<Props> {
  _getDimensions() {
    const maxSize = Math.min(imgMaxWidth(), 320)
    return clampImageSize(
      {
        height: this.props.height,
        width: this.props.width,
      },
      maxSize
    )
  }
  render() {
    return (
      <Kb.Image
        src={this.props.url}
        style={Styles.collapseStyles([this._getDimensions(), styles.image, this.props.style])}
      />
    )
  }
}

const styles = Styles.styleSheetCreate({
  image: {
    borderRadius: Styles.borderRadius,
  },
})

export default UnfurlImage