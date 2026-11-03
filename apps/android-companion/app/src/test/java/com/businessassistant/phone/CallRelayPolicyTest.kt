package com.businessassistant.phone

import org.junit.Assert.*
import org.junit.Test

class CallRelayPolicyTest {
    @Test fun historyConsentNeverUpgradesOldCallsAndRevocationInvalidatesCapturedVersions() {
        assertNull(CallRelayPolicy.historyVersion(0, 1))
        assertNull(CallRelayPolicy.historyVersion(1, 0))
        assertNull(CallRelayPolicy.historyVersion(1, 3))
        assertEquals(3, CallRelayPolicy.historyVersion(3, 3))
    }
    @Test fun dropsExpiredCallsAndIncorrectFutureClocks() {
        assertTrue(CallRelayPolicy.isFresh(100_000, 101_000))
        assertFalse(CallRelayPolicy.isFresh(100_000, 221_000))
        assertFalse(CallRelayPolicy.isFresh(160_000, 100_000))
    }
    @Test fun retriesNetworkAndTemporaryFailuresButStopsAuthAndValidationErrors() {
        listOf(null, 408, 429, 500, 503).forEach { assertTrue(CallRelayPolicy.shouldRetry(it)) }
        listOf(400, 401, 403, 404, 409, 422).forEach { assertFalse(CallRelayPolicy.shouldRetry(it)) }
    }
    @Test fun callRetriesUseSameEventIdWhileSeparateCallsAndOrganizationsStaySeparate() {
        val event = CallRelayPolicy.eventId("organization-a", "+821012345678", 100_000)
        assertEquals(event, CallRelayPolicy.eventId("organization-a", "+821012345678", 100_000))
        assertNotEquals(event, CallRelayPolicy.eventId("organization-b", "+821012345678", 100_000))
        assertNotEquals(event, CallRelayPolicy.eventId("organization-a", "+821012345678", 100_001))
    }
}
