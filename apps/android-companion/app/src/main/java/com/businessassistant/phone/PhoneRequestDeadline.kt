package com.businessassistant.phone

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Callable
import java.util.concurrent.ExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** One monotonic budget covers every directory page and its token refresh/retry. */
class PhoneRequestDeadline(timeoutMs: Long = 120000, private val now: ()->Long = { TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) }) {
 private val endsAt=now()+timeoutMs
 fun remainingMillis(): Int {
  val remaining=endsAt-now()
  check(remaining>0) { "번호부 동기화 시간이 초과됐습니다." }
  return remaining.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
 }
 fun <T> await(action: ()->T): T {
  remainingMillis()
  val future=NETWORK.submit(Callable { remainingMillis();action().also { remainingMillis() } })
  try {return future.get(remainingMillis().toLong(),TimeUnit.MILLISECONDS)}
  catch(error: TimeoutException) {throw IllegalStateException("번호부 동기화 시간이 초과됐습니다.",error)}
  catch(error: ExecutionException) {throw error.cause ?: error}
  catch(error: InterruptedException) {Thread.currentThread().interrupt();throw IllegalStateException("번호부 동기화가 취소됐습니다.",error)}
  finally {if(!future.isDone)future.cancel(true);NETWORK.purge()}
 }
 companion object {
  // HttpURLConnection readTimeout limits inactivity, not an entire response.
  // Timed Future.get also releases the sync caller for drip headers/bodies or an
  // OS call that ignores interruption. The network task never commits a directory.
  // At most one lingering network task and one pending call can exist.
  private val NETWORK=ThreadPoolExecutor(1,1,0L,TimeUnit.MILLISECONDS,ArrayBlockingQueue<Runnable>(1),{task->Thread(task,"phone-directory-http").apply { isDaemon=true }},ThreadPoolExecutor.AbortPolicy())
 }
}
