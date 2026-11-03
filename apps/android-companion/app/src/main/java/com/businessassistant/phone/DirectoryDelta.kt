package com.businessassistant.phone

/** Staging is private until all pages validate; caller persists the finished snapshot once. */
data class DirectoryChange(val customerId: String, val entry: PhoneEntry?, val revision: Long? = null)
data class DirectoryPage(val mode: String, val items: List<DirectoryChange>, val revision: Long, val nextCursor: String?, val cursor: String?, val resetRequired: Boolean = false)
data class DirectorySnapshot(val entries: List<PhoneEntry>, val cursor: String?, val revision: Long = 0)
class DirectoryDelta(initialCursor: String?, entries: List<PhoneEntry>, initialRevision: Long = 0) {
 private val staged=entries.associateBy { it.customerId }.toMutableMap()
 private val seen=mutableSetOf<String>().apply { initialCursor?.let { add(it) } }
 private var previousMode: String?=null
 private var revision=initialRevision
 private var lastChange=initialRevision
 private var lastSnapshotId: String?=null
 private val initialSnapshot=initialCursor==null
 private var pages=0
 private var checkpoint: String?=null
 var complete=false; private set
 var resetRequired=false; private set
 fun accept(page: DirectoryPage) {
  check(!complete && !resetRequired && ++pages<=500) { "번호부 페이지 한도를 초과했습니다." }
  check(page.revision>=revision && page.items.size<=200) { "번호부 순서가 올바르지 않습니다." }
  if(page.resetRequired) {check(page.items.isEmpty() && page.nextCursor==null && page.cursor==null);resetRequired=true;return}
  check(page.mode in listOf("snapshot","delta"))
  check((page.nextCursor==null)!=(page.cursor==null))
  if(previousMode==null)check(page.mode==if(initialSnapshot)"snapshot" else "delta")
  if(previousMode=="delta")check(page.mode=="delta")
  if(previousMode=="snapshot" && page.mode=="snapshot")check(page.revision==revision)
  if(page.mode=="snapshot") {
   if(previousMode==null)staged.clear()
   check(page.cursor==null) { "초기 번호부의 변경 확인이 필요합니다." }
   for(change in page.items) {
    check(change.entry!=null && change.customerId==change.entry.customerId && (lastSnapshotId==null || change.customerId>lastSnapshotId!!))
    check(change.customerId !in staged);staged[change.customerId]=change.entry;lastSnapshotId=change.customerId
   }
   lastChange=page.revision
  } else {
   for(change in page.items) {
    val changedAt=checkNotNull(change.revision);check(changedAt>lastChange && changedAt<=page.revision);lastChange=changedAt
    check(change.entry==null || change.customerId==change.entry.customerId)
    if(change.entry==null)staged.remove(change.customerId) else staged[change.customerId]=change.entry
   }
  }
  check(staged.size<=100000) { "번호부가 너무 큽니다." }
  check(page.nextCursor==null || seen.add(page.nextCursor)) { "번호부 페이지가 반복됐습니다." }
  revision=page.revision;previousMode=page.mode
  if(page.cursor!=null){checkpoint=page.cursor;complete=true}
 }
 fun entries(): List<PhoneEntry> {check(complete);return staged.values.toList()}
 fun checkpoint(): String {check(complete);return checkNotNull(checkpoint)}
 fun snapshot(): DirectorySnapshot=DirectorySnapshot(entries(),checkpoint(),revision)
}

object DirectorySyncEngine {
 fun sync(initial: DirectorySnapshot, fetch: (String?)->DirectoryPage, stillAllowed: ()->Boolean, commit: (DirectorySnapshot)->Unit, now: ()->Long = { java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) }): DirectorySnapshot {
  val deadline=now()+120000L
  var current=initial;var resets=0;var pages=0
  while(true) {
   val staging=DirectoryDelta(current.cursor,current.entries,current.revision);var cursor=current.cursor
   do {
    check(stillAllowed() && now()<deadline && ++pages<=500) { "전화 연동 상태가 변경됐거나 동기화 시간이 초과됐습니다." }
    val page=fetch(cursor)
    check(stillAllowed() && now()<deadline)
    staging.accept(page)
    if(staging.resetRequired)break
    cursor=page.nextCursor
   } while(!staging.complete)
   if(staging.resetRequired){check(++resets<=1);current=DirectorySnapshot(emptyList(),null);continue}
   val result=staging.snapshot()
   check(stillAllowed() && now()<deadline)
   commit(result)
   return result
  }
 }
}
