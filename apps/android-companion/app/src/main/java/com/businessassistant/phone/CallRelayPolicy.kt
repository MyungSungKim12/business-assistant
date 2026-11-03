package com.businessassistant.phone

/** Pure delivery rules shared by the encrypted queue and background worker. */
object CallRelayPolicy {
    // A retry cannot acquire consent granted after the call was captured.
    fun historyVersion(queuedVersion: Int, currentVersion: Int): Int? = queuedVersion.takeIf { it > 0 && it == currentVersion }
    fun isFresh(createdAt: Long, now: Long): Boolean = now - createdAt in -30_000L..120_000L
    fun shouldRetry(status: Int?): Boolean = status == null || status == 408 || status == 429 || status >= 500
    fun eventId(organization: String, normalizedNumber: String, createdAt: Long): String =
        java.util.UUID.nameUUIDFromBytes("$organization:$normalizedNumber:$createdAt".toByteArray(Charsets.UTF_8)).toString()
}
