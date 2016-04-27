package libkbfs

import (
	"errors"
	"testing"

	"github.com/golang/mock/gomock"
	"github.com/keybase/client/go/libkb"
	"golang.org/x/net/context"
)

func mdOpsInit(t *testing.T) (mockCtrl *gomock.Controller,
	config *ConfigMock, ctx context.Context) {
	ctr := NewSafeTestReporter(t)
	mockCtrl = gomock.NewController(ctr)
	config = NewConfigMock(mockCtrl, ctr)
	mdops := &MDOpsStandard{config}
	config.SetMDOps(mdops)
	interposeDaemonKBPKI(config, "alice", "bob")
	ctx = context.Background()
	return
}

func mdOpsShutdown(mockCtrl *gomock.Controller, config *ConfigMock) {
	config.ctr.CheckForFailures()
	mockCtrl.Finish()
}

func newRMDS(t *testing.T, config Config, public bool) *RootMetadataSigned {
	id := FakeTlfID(1, public)

	h := parseTlfHandleOrBust(t, config, "alice,bob", public)
	rmds := &RootMetadataSigned{}
	err := updateNewRootMetadata(&rmds.MD, id, h.BareTlfHandle)
	if err != nil {
		t.Fatal(err)
	}
	rmds.MD.tlfHandle = h

	// Need to do this to avoid calls to the mocked-out MakeMdID.
	rmds.MD.mdID = fakeMdID(fakeTlfIDByte(id))

	rmds.MD.Revision = MetadataRevision(1)
	rmds.MD.LastModifyingWriter = h.Writers[0]
	rmds.MD.LastModifyingUser = h.Writers[0]
	rmds.SigInfo = SignatureInfo{
		Version:      SigED25519,
		Signature:    []byte{42},
		VerifyingKey: MakeFakeVerifyingKeyOrBust("fake key"),
	}

	if !public {
		FakeInitialRekey(&rmds.MD, h.BareTlfHandle)
	}

	return rmds
}

func verifyMDForPublic(config *ConfigMock, rmds *RootMetadataSigned,
	hasVerifyingKeyErr error, verifyErr error) {
	packedData := []byte{4, 3, 2, 1}
	config.mockKbpki.EXPECT().HasVerifyingKey(gomock.Any(), gomock.Any(),
		gomock.Any(), gomock.Any()).AnyTimes().Return(hasVerifyingKeyErr)
	if hasVerifyingKeyErr == nil {
		config.mockCodec.EXPECT().Encode(rmds.MD.WriterMetadata).Return(packedData, nil)
		config.mockCrypto.EXPECT().Verify(packedData, rmds.MD.WriterMetadataSigInfo).Return(nil)
		config.mockCodec.EXPECT().Encode(rmds.MD).AnyTimes().Return(packedData, nil)
		config.mockCrypto.EXPECT().Verify(packedData, rmds.SigInfo).Return(verifyErr)
		if verifyErr == nil {
			config.mockCodec.EXPECT().Decode(
				rmds.MD.SerializedPrivateMetadata,
				&rmds.MD.data).Return(nil)
		}
	}
}

func verifyMDForPrivate(config *ConfigMock, rmds *RootMetadataSigned) {
	config.mockCodec.EXPECT().Decode(rmds.MD.SerializedPrivateMetadata, gomock.Any()).
		Return(nil)
	expectGetTLFCryptKeyForMDDecryption(config, &rmds.MD)
	config.mockCrypto.EXPECT().DecryptPrivateMetadata(
		gomock.Any(), TLFCryptKey{}).Return(&rmds.MD.data, nil)

	packedData := []byte{4, 3, 2, 1}
	config.mockCodec.EXPECT().Encode(rmds.MD).Return(packedData, nil)
	config.mockCodec.EXPECT().Encode(rmds.MD.WriterMetadata).Return(packedData, nil)
	config.mockKbpki.EXPECT().HasVerifyingKey(gomock.Any(), gomock.Any(),
		gomock.Any(), gomock.Any()).AnyTimes().Return(nil)
	config.mockCrypto.EXPECT().Verify(packedData, rmds.SigInfo).Return(nil)
	config.mockCrypto.EXPECT().Verify(packedData, rmds.MD.WriterMetadataSigInfo).Return(nil)
}

func putMDForPublic(config *ConfigMock, rmds *RootMetadataSigned,
	id TlfID) {
	// TODO make this more explicit. Currently can't because the `Put`
	// call mutates `rmds.MD`, which makes the EXPECT() not match.
	// Encodes:
	// 1) rmds.MD.data
	// 2) rmds.MD.WriterMetadata
	// 3) rmds.MD
	config.mockCodec.EXPECT().Encode(gomock.Any()).Times(3).Return([]byte{}, nil)
	config.mockCrypto.EXPECT().Sign(gomock.Any(), gomock.Any()).Times(2).Return(SignatureInfo{}, nil)

	config.mockCodec.EXPECT().Decode([]byte{}, gomock.Any()).Return(nil)

	config.mockMdserv.EXPECT().Put(gomock.Any(), gomock.Any()).Return(nil)
}

func putMDForPrivate(config *ConfigMock, rmds *RootMetadataSigned) {
	expectGetTLFCryptKeyForEncryption(config, &rmds.MD)
	config.mockCrypto.EXPECT().EncryptPrivateMetadata(
		&rmds.MD.data, TLFCryptKey{}).Return(EncryptedPrivateMetadata{}, nil)

	packedData := []byte{4, 3, 2, 1}
	// TODO make these EXPECTs more specific.
	// Encodes:
	// 1) encrypted rmds.MD.data
	// 2) rmds.MD.WriterMetadata
	// 3) rmds.MD
	config.mockCodec.EXPECT().Encode(gomock.Any()).Return(packedData, nil).Times(3).Return([]byte{}, nil)

	config.mockCrypto.EXPECT().Sign(gomock.Any(), gomock.Any()).Times(2).Return(SignatureInfo{}, nil)

	config.mockCodec.EXPECT().Decode([]byte{}, gomock.Any()).Return(nil)

	config.mockMdserv.EXPECT().Put(gomock.Any(), gomock.Any()).Return(nil)
}

func TestMDOpsGetForHandlePublicSuccess(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it
	rmds := newRMDS(t, config, true)

	// Do this before setting tlfHandle to nil.
	verifyMDForPublic(config, rmds, nil, nil)

	h := rmds.MD.GetTlfHandle()

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	config.mockMdserv.EXPECT().GetForHandle(ctx, h.BareTlfHandle, Merged).Return(NullTlfID, rmds, nil)

	if rmd2, err := config.MDOps().GetForHandle(ctx, h); err != nil {
		t.Errorf("Got error on get: %v", err)
	} else if rmd2.ID != rmds.MD.ID {
		t.Errorf("Got back wrong id on get: %v (expected %v)", rmd2.ID, rmds.MD.ID)
	} else if rmd2 != &rmds.MD {
		t.Errorf("Got back wrong data on get: %v (expected %v)", rmd2, &rmds.MD)
	}
}

func TestMDOpsGetForHandlePrivateSuccess(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it
	rmds := newRMDS(t, config, false)

	// Do this before setting tlfHandle to nil.
	verifyMDForPrivate(config, rmds)

	h := rmds.MD.GetTlfHandle()

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	config.mockMdserv.EXPECT().GetForHandle(ctx, h.BareTlfHandle, Merged).Return(NullTlfID, rmds, nil)

	if rmd2, err := config.MDOps().GetForHandle(ctx, h); err != nil {
		t.Errorf("Got error on get: %v", err)
	} else if rmd2.ID != rmds.MD.ID {
		t.Errorf("Got back wrong id on get: %v (expected %v)", rmd2.ID, rmds.MD.ID)
	} else if rmd2 != &rmds.MD {
		t.Errorf("Got back wrong data on get: %v (expected %v)", rmd2, &rmds.MD)
	}
}

func TestMDOpsGetForHandlePublicFailFindKey(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it
	rmds := newRMDS(t, config, true)

	// Do this before setting tlfHandle to nil.
	verifyMDForPublic(config, rmds, KeyNotFoundError{}, nil)

	h := rmds.MD.GetTlfHandle()

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	config.mockMdserv.EXPECT().GetForHandle(ctx, h.BareTlfHandle, Merged).Return(NullTlfID, rmds, nil)

	_, err := config.MDOps().GetForHandle(ctx, h)
	if _, ok := err.(UnverifiableTlfUpdateError); !ok {
		t.Errorf("Got unexpected error on get: %v", err)
	}
}

func TestMDOpsGetForHandlePublicFailVerify(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it
	rmds := newRMDS(t, config, true)

	// Do this before setting tlfHandle to nil.
	expectedErr := libkb.VerificationError{}
	verifyMDForPublic(config, rmds, nil, expectedErr)

	h := rmds.MD.GetTlfHandle()

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	config.mockMdserv.EXPECT().GetForHandle(ctx, h.BareTlfHandle, Merged).Return(NullTlfID, rmds, nil)

	if _, err := config.MDOps().GetForHandle(ctx, h); err != expectedErr {
		t.Errorf("Got unexpected error on get: %v", err)
	}
}

func TestMDOpsGetForHandleFailGet(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	h := parseTlfHandleOrBust(t, config, "alice,bob", false)

	// expect one call to fetch MD, and fail it
	err := errors.New("Fake fail")

	// only the get happens, no verify needed with a blank sig
	config.mockMdserv.EXPECT().GetForHandle(ctx, h.BareTlfHandle, Merged).Return(NullTlfID, nil, err)

	if _, err2 := config.MDOps().GetForHandle(ctx, h); err2 != err {
		t.Errorf("Got bad error on get: %v", err2)
	}
}

func TestMDOpsGetForHandleFailHandleCheck(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it, and fail that one
	rmds := newRMDS(t, config, false)

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	// Make a different handle.
	otherH := parseTlfHandleOrBust(t, config, "alice", false)
	config.mockMdserv.EXPECT().GetForHandle(ctx, otherH.BareTlfHandle, Merged).Return(NullTlfID, rmds, nil)

	if _, err := config.MDOps().GetForHandle(ctx, otherH); err == nil {
		t.Errorf("Got no error on bad handle check test")
	} else if _, ok := err.(MDMismatchError); !ok {
		t.Errorf("Got unexpected error on bad handle check test: %v", err)
	}
}

func TestMDOpsGetSuccess(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it
	rmds := newRMDS(t, config, false)

	// Do this before setting tlfHandle to nil.
	verifyMDForPrivate(config, rmds)

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	config.mockMdserv.EXPECT().GetForTLF(ctx, rmds.MD.ID, NullBranchID, Merged).Return(rmds, nil)

	if rmd2, err := config.MDOps().GetForTLF(ctx, rmds.MD.ID); err != nil {
		t.Errorf("Got error on get: %v", err)
	} else if rmd2 != &rmds.MD {
		t.Errorf("Got back wrong data on get: %v (expected %v)", rmd2, &rmds.MD)
	}
}

func TestMDOpsGetBlankSigFailure(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, give back a blank sig that
	// should fail verification
	rmds := newRMDS(t, config, false)
	rmds.SigInfo = SignatureInfo{}

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	// only the get happens, no verify needed with a blank sig
	config.mockMdserv.EXPECT().GetForTLF(ctx, rmds.MD.ID, NullBranchID, Merged).Return(rmds, nil)

	if _, err := config.MDOps().GetForTLF(ctx, rmds.MD.ID); err == nil {
		t.Error("Got no error on get")
	}
}

func TestMDOpsGetFailGet(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and fail it
	id := FakeTlfID(1, true)
	err := errors.New("Fake fail")

	// only the get happens, no verify needed with a blank sig
	config.mockMdserv.EXPECT().GetForTLF(ctx, id, NullBranchID, Merged).Return(nil, err)

	if _, err2 := config.MDOps().GetForTLF(ctx, id); err2 != err {
		t.Errorf("Got bad error on get: %v", err2)
	}
}

func TestMDOpsGetFailIdCheck(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it, and fail that one
	rmds := newRMDS(t, config, false)

	id2 := FakeTlfID(2, true)

	// Set tlfHandle to nil so that the md server returns a
	// 'deserialized' RMDS.
	rmds.MD.tlfHandle = nil

	config.mockMdserv.EXPECT().GetForTLF(ctx, id2, NullBranchID, Merged).Return(rmds, nil)

	if _, err := config.MDOps().GetForTLF(ctx, id2); err == nil {
		t.Errorf("Got no error on bad id check test")
	} else if _, ok := err.(MDMismatchError); !ok {
		t.Errorf("Got unexpected error on bad id check test: %v", err)
	}
}

func testMDOpsGetRangeSuccess(t *testing.T, fromStart bool) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it
	rmds1 := newRMDS(t, config, false)

	rmds2 := newRMDS(t, config, false)

	rmds2.MD.mdID = fakeMdID(42)
	rmds1.MD.PrevRoot = rmds2.MD.mdID
	rmds1.MD.Revision = 102

	rmds3 := newRMDS(t, config, false)

	rmds3.MD.mdID = fakeMdID(43)
	rmds2.MD.PrevRoot = rmds3.MD.mdID
	rmds2.MD.Revision = 101
	mdID4 := fakeMdID(44)
	rmds3.MD.PrevRoot = mdID4
	rmds3.MD.Revision = 100

	start, stop := MetadataRevision(100), MetadataRevision(102)
	if fromStart {
		start = 0
	}

	// Do this before setting tlfHandles to nil.
	verifyMDForPrivate(config, rmds3)
	verifyMDForPrivate(config, rmds2)
	verifyMDForPrivate(config, rmds1)

	// Set tlfHandles to nil so that the md server returns
	// 'deserialized' RMDSes.
	rmds1.MD.tlfHandle = nil
	rmds2.MD.tlfHandle = nil
	rmds3.MD.tlfHandle = nil

	allRMDSs := []*RootMetadataSigned{rmds3, rmds2, rmds1}

	config.mockMdserv.EXPECT().GetRange(ctx, rmds1.MD.ID, NullBranchID, Merged, start,
		stop).Return(allRMDSs, nil)

	allRMDs, err := config.MDOps().GetRange(ctx, rmds1.MD.ID, start, stop)
	if err != nil {
		t.Errorf("Got error on GetRange: %v", err)
	} else if len(allRMDs) != 3 {
		t.Errorf("Got back wrong number of RMDs: %d", len(allRMDs))
	}
}

func TestMDOpsGetRangeSuccess(t *testing.T) {
	testMDOpsGetRangeSuccess(t, false)
}

func TestMDOpsGetRangeFromStartSuccess(t *testing.T) {
	testMDOpsGetRangeSuccess(t, true)
}

func TestMDOpsGetRangeFailBadPrevRoot(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to fetch MD, and one to verify it
	rmds1 := newRMDS(t, config, false)

	rmds2 := newRMDS(t, config, false)

	rmds2.MD.mdID = fakeMdID(42)
	rmds1.MD.PrevRoot = fakeMdID(46) // points to some random ID
	rmds1.MD.Revision = 202

	rmds3 := newRMDS(t, config, false)

	rmds3.MD.mdID = fakeMdID(43)
	rmds2.MD.PrevRoot = rmds3.MD.mdID
	rmds2.MD.Revision = 201
	mdID4 := fakeMdID(44)
	rmds3.MD.PrevRoot = mdID4
	rmds3.MD.Revision = 200

	// Do this before setting tlfHandle to nil.
	verifyMDForPrivate(config, rmds3)
	verifyMDForPrivate(config, rmds2)

	// Set tlfHandle to nil so that the md server returns
	// 'deserialized' RMDSes.
	rmds1.MD.tlfHandle = nil
	rmds2.MD.tlfHandle = nil
	rmds3.MD.tlfHandle = nil

	allRMDSs := []*RootMetadataSigned{rmds3, rmds2, rmds1}

	start, stop := MetadataRevision(200), MetadataRevision(202)
	config.mockMdserv.EXPECT().GetRange(ctx, rmds1.MD.ID, NullBranchID, Merged, start,
		stop).Return(allRMDSs, nil)

	_, err := config.MDOps().GetRange(ctx, rmds1.MD.ID, start, stop)
	if err == nil {
		t.Errorf("Got no expected error on GetSince")
	} else if _, ok := err.(MDMismatchError); !ok {
		t.Errorf("Got unexpected error on GetSince with bad PrevRoot chain: %v",
			err)
	}
}

func TestMDOpsPutPublicSuccess(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to sign MD, and one to put it
	rmds := newRMDS(t, config, true)
	putMDForPublic(config, rmds, rmds.MD.ID)

	if err := config.MDOps().Put(ctx, &rmds.MD); err != nil {
		t.Errorf("Got error on put: %v", err)
	}
}

func TestMDOpsPutPrivateSuccess(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to sign MD, and one to put it
	rmds := newRMDS(t, config, false)
	putMDForPrivate(config, rmds)

	if err := config.MDOps().PutUnmerged(ctx, &rmds.MD, NullBranchID); err != nil {
		t.Errorf("Got error on put: %v", err)
	}
}

func TestMDOpsPutFailEncode(t *testing.T) {
	mockCtrl, config, ctx := mdOpsInit(t)
	defer mdOpsShutdown(mockCtrl, config)

	// expect one call to sign MD, and fail it
	id := FakeTlfID(1, false)
	h := parseTlfHandleOrBust(t, config, "alice,bob", false)
	rmd := newRootMetadataOrBust(t, id, h)

	expectGetTLFCryptKeyForEncryption(config, rmd)
	config.mockCrypto.EXPECT().EncryptPrivateMetadata(
		&rmd.data, TLFCryptKey{}).Return(EncryptedPrivateMetadata{}, nil)

	err := errors.New("Fake fail")
	config.mockCodec.EXPECT().Encode(gomock.Any()).Return(nil, err)

	if err2 := config.MDOps().Put(ctx, rmd); err2 != err {
		t.Errorf("Got bad error on put: %v", err2)
	}
}
