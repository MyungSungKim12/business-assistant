package com.businessassistant.phone

data class PhoneEntry(val customerId: String, val name: String, val phone: String, val phoneE164: String)

object PhoneMatcher {
    fun normalize(value: String?): String? {
        val text = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (text.any { it.isLetter() }) return null
        val plus = text.startsWith('+')
        var digits = text.filter(Char::isDigit)
        if (digits.startsWith("0082")) digits = "82" + digits.drop(4)
        else if (!plus && digits.startsWith("00")) digits = digits.drop(2)
        if (digits.startsWith("82")) digits = "0" + digits.drop(2)
        if (digits.startsWith('0')) {
            if (digits.length !in 8..11 || digits.all { it == '0' }) return null
            if (Regex("^0(?:10|11|16|17|18|19)0{4,}").containsMatchIn(digits)) return null
            return "+82" + digits.drop(1)
        }
        if (!plus || digits.length !in 8..15 || digits.all { it == '0' }) return null
        return "+$digits"
    }

    fun find(number: String?, entries: List<PhoneEntry>): List<PhoneEntry> {
        val normalized = normalize(number) ?: return emptyList()
        return entries.filter { it.phoneE164 == normalized }
    }
}
