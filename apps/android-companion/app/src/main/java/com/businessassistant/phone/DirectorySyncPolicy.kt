package com.businessassistant.phone

/** No caller numbers are uploaded when the local directory is out of date. */
object DirectorySyncPolicy {
    const val REFRESH_AFTER_MS = 5 * 60 * 1000L
    const val STALE_AFTER_MS = 30 * 60 * 1000L
    fun needsRefresh(syncedAt: Long, now: Long): Boolean = syncedAt <= 0 || syncedAt > now || now - syncedAt >= REFRESH_AFTER_MS
    fun isStale(syncedAt: Long, now: Long): Boolean = syncedAt <= 0 || syncedAt > now || now - syncedAt >= STALE_AFTER_MS
    fun mayCommit(expected: String, current: String): Boolean = expected == current
}
