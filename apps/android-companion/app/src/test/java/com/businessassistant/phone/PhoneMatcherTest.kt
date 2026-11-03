package com.businessassistant.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneMatcherTest {
    @Test fun normalizesKoreanLocalAndCountryCodeNumbers() {
        assertEquals("+821012345678", PhoneMatcher.normalize("010-1234-5678"))
        assertEquals("+821012345678", PhoneMatcher.normalize("+82 10 1234 5678"))
        assertEquals("+82212345678", PhoneMatcher.normalize("02-1234-5678"))
    }

    @Test fun doesNotMatchPrivateOrMalformedNumbers() {
        assertNull(PhoneMatcher.normalize(null))
        assertNull(PhoneMatcher.normalize("발신번호 표시제한"))
        assertNull(PhoneMatcher.normalize("010-123"))
        assertNull(PhoneMatcher.normalize("00000000000"))
    }

    @Test fun returnsNoMatchAndAmbiguousResultsWithoutChoosingArbitrarily() {
        val one = PhoneEntry("id-1", "김고객", "01012345678", "+821012345678")
        assertEquals(listOf(one), PhoneMatcher.find("010-1234-5678", listOf(one)))
        assertEquals(emptyList<PhoneEntry>(), PhoneMatcher.find("010-9999-9999", listOf(one)))
        val duplicate = one.copy(customerId = "id-2", name = "이중복")
        assertEquals(listOf(one, duplicate), PhoneMatcher.find("+821012345678", listOf(one, duplicate)))
    }
}
