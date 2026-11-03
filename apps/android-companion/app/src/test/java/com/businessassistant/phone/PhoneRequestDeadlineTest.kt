package com.businessassistant.phone

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class PhoneRequestDeadlineTest {
 @Test fun dripOrStuckRequestCannotExtendAbsoluteWaitBudget() {
  val release=CountDownLatch(1);val started=CountDownLatch(1)
  val deadline=PhoneRequestDeadline(75)
  var commits=0
  val before=System.nanoTime()
  try {
   assertThrows(IllegalStateException::class.java){DirectorySyncEngine.sync(DirectorySnapshot(emptyList(),"old"),fetch={deadline.await {started.countDown();while(release.count>0){try{release.await(10,TimeUnit.MILLISECONDS)}catch(_:InterruptedException){}};DirectoryPage("delta",emptyList(),0,null,"late")}},stillAllowed={true},commit={commits++})}
   assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime()-before)<2000)
   assertEquals(0L,started.count)
   assertEquals(0,commits)
  } finally {release.countDown()}
 }
 @Test fun allPagesAndRefreshShareOneBudgetRatherThanRestartingIt() {
  var now=1000L;val deadline=PhoneRequestDeadline(120000,now={now})
  assertEquals(120000,deadline.remainingMillis());now=120999
  assertEquals(1,deadline.remainingMillis());now=121000
  assertThrows(IllegalStateException::class.java){deadline.remainingMillis()}
 }
 @Test fun returnsSuccessAndPropagatesFailureWithoutInventingAResult() {
  assertEquals("page",PhoneRequestDeadline(2000).await{"page"})
  assertThrows(IllegalStateException::class.java){PhoneRequestDeadline(2000).await<String>{error("offline")}}
 }
}
