package com.businessassistant.phone

import org.junit.Assert.*
import org.junit.Test

class DirectorySyncPolicyTest {
    @Test fun refreshAndStaleThresholdsAreSeparate() {
        val now = 10000000L
        assertFalse(DirectorySyncPolicy.needsRefresh(now - 1000, now))
        assertTrue(DirectorySyncPolicy.needsRefresh(now - DirectorySyncPolicy.REFRESH_AFTER_MS, now))
        assertFalse(DirectorySyncPolicy.isStale(now - DirectorySyncPolicy.REFRESH_AFTER_MS, now))
        assertTrue(DirectorySyncPolicy.isStale(now - DirectorySyncPolicy.STALE_AFTER_MS, now))
    }
    @Test fun missingOrFutureTimestampsRequireRefresh() {
        for (timestamp in listOf(0L, -1L, 1001L)) {
            assertTrue(DirectorySyncPolicy.needsRefresh(timestamp, 1000L))
            assertTrue(DirectorySyncPolicy.isStale(timestamp, 1000L))
        }
    }
    @Test fun oldSessionCannotCommitANewDirectory() {
        assertTrue(DirectorySyncPolicy.mayCommit("session-a", "session-a"))
        assertFalse(DirectorySyncPolicy.mayCommit("session-a", "session-b"))
    }
}
