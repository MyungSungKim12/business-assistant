package com.businessassistant.phone

import org.junit.Assert.*
import org.junit.Test

class DirectoryDeltaTest {
 private val a=PhoneEntry("a","고객","01012345678","+821012345678")
 private fun page(mode:String="delta", items:List<DirectoryChange> = emptyList(), revision:Long=2, next:String?=null, cursor:String?="checkpoint", reset:Boolean=false)=DirectoryPage(mode,items.mapIndexed{index,item->if(mode=="delta"&&item.revision==null)item.copy(revision=revision-items.size+index+1)else item},revision,next,cursor,reset)
 @Test fun snapshotThenDeltaAndTombstonesCommitOnlyAfterLastPage() {
  val sync=DirectoryDelta(null,emptyList());sync.accept(page("snapshot",listOf(DirectoryChange("a",a)),1,"next",null))
  assertFalse(sync.complete);sync.accept(page(items=listOf(DirectoryChange("a",null),DirectoryChange("b",a.copy(customerId="b"))),revision=3))
  assertEquals(listOf("b"),sync.entries().map{it.customerId});assertEquals("checkpoint",sync.checkpoint())
 }
 @Test fun samePhoneCustomersRemainSeparateAndUnchangedDeltaPreservesEntries() {
  val sync=DirectoryDelta("old",listOf(a,a.copy(customerId="b")));sync.accept(page());assertEquals(2,sync.entries().size)
 }
 @Test fun failuresDoNotExposePartialResultOrAcceptReplayedOrReversedPages() {
  val sync=DirectoryDelta("old",listOf(a));sync.accept(page(next="next",cursor=null))
  assertThrows(IllegalStateException::class.java){sync.entries()}
  assertThrows(IllegalStateException::class.java){sync.accept(page(next="next",cursor=null))}
  val reverse=DirectoryDelta("old",listOf(a));reverse.accept(page(next="p",cursor=null))
  assertThrows(IllegalStateException::class.java){reverse.accept(page(revision=1))}
 }
 @Test fun expiredCursorResetsIntoFreshSnapshotAndRejectsMalformedStateTransitions() {
  val sync=DirectoryDelta("old",listOf(a));sync.accept(page(reset=true,cursor=null));assertTrue(sync.resetRequired)
  val fresh=DirectoryDelta(null,emptyList());fresh.accept(page("snapshot",revision=4,next="delta",cursor=null));fresh.accept(page(revision=4));assertTrue(fresh.complete)
  assertThrows(IllegalStateException::class.java){DirectoryDelta("old",listOf(a)).accept(page("snapshot"))}
 }
 @Test fun multipleSnapshotPagesThenRenameDeleteDeltaAreApplied() {
  val sync=DirectoryDelta(null,emptyList())
  sync.accept(page("snapshot",listOf(DirectoryChange("a",a)),1,"s1",null))
  sync.accept(page("snapshot",listOf(DirectoryChange("b",a.copy(customerId="b"))),1,"d1",null))
  sync.accept(page(items=listOf(DirectoryChange("a",a.copy(name="변경"),2)),revision=2))
  assertEquals(2,sync.entries().size);assertEquals("변경",sync.entries().first{it.customerId=="a"}.name)
 }
 @Test fun middleFailureAndConsentOrAccountChangeNeverCommit() {
  for(reason in listOf("network","generation","consent")) {
   var calls=0;var allowed=true;var commits=0
   assertThrows(IllegalStateException::class.java){DirectorySyncEngine.sync(DirectorySnapshot(listOf(a),"old"),fetch={
    calls++;if(calls==1)page(next="next",cursor=null) else {if(reason=="network")error("offline");allowed=false;page()}
   },stillAllowed={allowed},commit={commits++})}
   assertEquals(0,commits)
  }
 }
 @Test fun expiredCursorRestartsOnceAndNoChangeStillCommitsOneFreshPayload() {
  var calls=0;var commits=0
  val result=DirectorySyncEngine.sync(DirectorySnapshot(listOf(a),"old"),fetch={cursor ->
   calls++;when(calls){1->{assertEquals("old",cursor);page(reset=true,cursor=null)};2->{assertNull(cursor);page("snapshot",revision=3,next="delta",cursor=null)};else->page(revision=3)}
  },stillAllowed={true},commit={commits++})
  assertEquals(1,commits);assertTrue(result.entries.isEmpty())
  DirectorySyncEngine.sync(DirectorySnapshot(listOf(a),"old"),fetch={page()},stillAllowed={true},commit={commits++})
  assertEquals(2,commits)
 }
 @Test fun reversedChangesStorageOverflowAndDeadlineAbortWithoutCommit() {
  val reverse=DirectoryDelta("old",listOf(a));assertThrows(IllegalStateException::class.java){reverse.accept(page(items=listOf(DirectoryChange("a",a,2),DirectoryChange("a",null,1))))}
  var time=0L;var commits=0
  assertThrows(IllegalStateException::class.java){DirectorySyncEngine.sync(DirectorySnapshot(listOf(a),"old"),fetch={time=120001;page()},stillAllowed={true},commit={commits++},now={time})}
  assertEquals(0,commits)
  val tooLarge=DirectoryDelta("old",(0..100000).map{a.copy(customerId=it.toString())})
  assertThrows(IllegalStateException::class.java){tooLarge.accept(page())}
 }
}
