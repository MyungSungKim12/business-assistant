package com.businessassistant.phone

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Refresh token and the minimum caller-ID index are AES-GCM encrypted with a non-exportable Android Keystore key. */
class SecurePhoneStore(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = context.applicationContext.getSharedPreferences("phone-companion-secure", Context.MODE_PRIVATE)

    fun saveRefreshToken(token: String, expectedGeneration: String? = null) = synchronized(STATE_LOCK) {
        check(expectedGeneration == null || generation() == expectedGeneration) { "로그인 또는 전화 연동 상태가 변경됐습니다." }
        preferences.edit().putString(TOKEN_KEY, encrypt(token)).apply()
    }
    fun loadRefreshToken(): String? = preferences.getString(TOKEN_KEY, null)?.let(::decryptOrClear)

    fun saveDirectory(organizationId: String, entries: List<PhoneEntry>, expectedGeneration: String, cursor: String? = null, revision: Long = 0) = synchronized(STATE_LOCK) {
        check(DirectorySyncPolicy.mayCommit(expectedGeneration, generation())) { "전화 연동 상태가 변경되어 번호부를 저장하지 않았습니다." }
        check(hasSyncConsent(organizationId)) { "고객 번호부 동기화 동의가 필요합니다." }
        val rows = JSONArray()
        entries.forEach { row -> rows.put(JSONObject().put("customer_id", row.customerId).put("name", row.name).put("phone", row.phone).put("phone_e164", row.phoneE164)) }
        val payload = JSONObject().put("organization_id", organizationId).put("items", rows).put("synced_at", System.currentTimeMillis()).put("cursor",cursor?:JSONObject.NULL).put("revision",revision.toString()).toString()
        // One authenticated encrypted value contains data + checkpoint + freshness.
        // A synchronous failed disk commit must not be reported as a fresh sync.
        val encrypted=encrypt(payload)
        val previous=preferences.getString(DIRECTORY_KEY,null)
        if(!preferences.edit().putString(DIRECTORY_KEY, encrypted).commit()) {
            // SharedPreferences updates its in-memory map even on a failed disk
            // write. Restore that view too so a failed sync never appears fresh.
            val restore=preferences.edit()
            if(previous==null)restore.remove(DIRECTORY_KEY) else restore.putString(DIRECTORY_KEY,previous)
            restore.commit()
            error("번호부를 저장하지 못했습니다.")
        }
    }

    fun saveSyncConsent(organizationId: String, expectedGeneration: String? = null) = synchronized(STATE_LOCK) {
        check(expectedGeneration == null || generation() == expectedGeneration) { "전화 연동 상태가 변경됐습니다." }
        preferences.edit().putString(CONSENT_KEY, encrypt(organizationId)).apply()
    }
    fun lastDirectorySyncAt(organizationId: String): Long = try {
        val payload=preferences.getString(DIRECTORY_KEY,null)?.let(::decrypt)?.let(::JSONObject)
        if(payload?.optString("organization_id")==organizationId) payload.optLong("synced_at",0) else 0
    } catch (_: Exception) { 0 }
    fun hasSyncConsent(organizationId: String): Boolean = preferences.getString(CONSENT_KEY, null)?.let(::decryptOrClear) == organizationId

    fun loadDirectorySnapshot(organizationId: String): DirectorySnapshot = synchronized(STATE_LOCK) {
        val payload=try { preferences.getString(DIRECTORY_KEY,null)?.let(::decrypt)?.let(::JSONObject) } catch (_: Exception) { null }
        if(payload?.optString("organization_id")!=organizationId)return DirectorySnapshot(emptyList(),null)
        val cursor=payload.optString("cursor").takeIf { it.isNotBlank() && it!="null" }
        // Old encrypted payloads have no checkpoint and bootstrap automatically.
        DirectorySnapshot(loadDirectory(organizationId),cursor,payload.optString("revision","0").toLongOrNull()?:0)
    }

    fun loadDirectory(organizationId: String): List<PhoneEntry> {
        val encrypted = preferences.getString(DIRECTORY_KEY, null) ?: return emptyList()
        return try {
            val payload = JSONObject(decrypt(encrypted))
            if (payload.optString("organization_id") != organizationId) return emptyList()
            val rows = payload.getJSONArray("items")
            (0 until rows.length()).mapNotNull { index ->
                val item = rows.optJSONObject(index) ?: return@mapNotNull null
                PhoneEntry(item.getString("customer_id"), item.getString("name"), item.getString("phone"), item.getString("phone_e164"))
            }
        } catch (_: Exception) {
            clearDirectory()
            emptyList()
        }
    }

    fun activeOrganizationId(): String? = try {
        preferences.getString(DIRECTORY_KEY, null)?.let(::decrypt)?.let { JSONObject(it).optString("organization_id").takeIf(String::isNotBlank) }
    } catch (_: Exception) { clearDirectory(); null }

    fun generation(): String = synchronized(STATE_LOCK) {
        preferences.getString("session-generation", null) ?: java.util.UUID.randomUUID().toString().also { preferences.edit().putString("session-generation", it).apply() }
    }
    fun hasPcRelayConsent(organizationId: String): Boolean = preferences.getString("pc-relay-consent", null)?.let(::decryptOrClear) == organizationId
    fun historyConsentVersion(organizationId: String): Int = try {
        preferences.getString("history-consent", null)?.let(::decrypt)?.let(::JSONObject)?.let { if (it.optString("organization_id") == organizationId) it.optInt("version", 0) else 0 } ?: 0
    } catch (_: Exception) { 0 }
    fun setHistoryConsent(organizationId: String, version: Int, expectedGeneration: String? = null) = synchronized(STATE_LOCK) {
        check(expectedGeneration == null || generation() == expectedGeneration) { "전화 연동 상태가 변경됐습니다." }
        val edit = preferences.edit()
        if (version > 0) edit.putString("history-consent", encrypt(JSONObject().put("organization_id", organizationId).put("version", version).toString()))
        else edit.remove("history-consent")
        invalidateRequests()
        edit.putString("session-generation", java.util.UUID.randomUUID().toString())
        preferences.all.keys.filter { it.startsWith("pending-call:") }.forEach(edit::remove)
        edit.apply()
    }
    fun registerRequest(connection: java.net.HttpURLConnection, expectedGeneration: String) = synchronized(STATE_LOCK) {
        check(generation() == expectedGeneration) { "전화 연동 상태가 변경됐습니다." }
        ACTIVE_REQUESTS.add(connection)
    }
    fun finishRequest(connection: java.net.HttpURLConnection) = synchronized(STATE_LOCK) { ACTIVE_REQUESTS.remove(connection) }
    private fun invalidateRequests() { ACTIVE_REQUESTS.toList().forEach { it.disconnect() }; ACTIVE_REQUESTS.clear() }
    fun setPcRelayConsent(organizationId: String, enabled: Boolean) = synchronized(STATE_LOCK) {
        val edit = preferences.edit()
        if (enabled) edit.putString("pc-relay-consent", encrypt(organizationId))
        else {
            invalidateRequests()
            edit.remove("history-consent")
            edit.remove("pc-relay-consent").putString("session-generation", java.util.UUID.randomUUID().toString())
            preferences.all.keys.filter { it.startsWith("pending-call:") }.forEach(edit::remove)
        }
        edit.apply()
    }
    fun queueCall(eventId: String, organizationId: String, number: String, occurredAt: String): Boolean = synchronized(STATE_LOCK) {
        if (!hasPcRelayConsent(organizationId) || activeOrganizationId() != organizationId) return false
        if (DirectorySyncPolicy.isStale(lastDirectorySyncAt(organizationId),System.currentTimeMillis())) return false
        preferences.all.keys.filter { it.startsWith("pending-call:") }.forEach { pendingCall(it.removePrefix("pending-call:")) }
        val waiting = preferences.all.keys.filter { it.startsWith("pending-call:") }
        if (waiting.size >= 100) preferences.edit().remove(waiting.first()).apply()
        val payload = JSONObject().put("event_id", eventId).put("organization_id", organizationId).put("number", number).put("occurred_at", occurredAt).put("generation", generation()).put("history_version", historyConsentVersion(organizationId))
        preferences.edit().putString("pending-call:$eventId", encrypt(payload.toString())).apply()
        true
    }
    fun pendingCall(eventId: String): JSONObject? = synchronized(STATE_LOCK) {
        val payload = try { preferences.getString("pending-call:$eventId", null)?.let(::decrypt)?.let(::JSONObject) } catch (_: Exception) { null } ?: return null
        val organization = payload.getString("organization_id")
        val fresh = CallRelayPolicy.isFresh(java.time.Instant.parse(payload.getString("occurred_at")).toEpochMilli(), System.currentTimeMillis())
        if (!hasPcRelayConsent(organization) || activeOrganizationId() != organization || payload.getString("generation") != generation() || !fresh || DirectorySyncPolicy.isStale(lastDirectorySyncAt(organization),System.currentTimeMillis())) { removePendingCall(eventId); return null }
        payload
    }
    fun removePendingCall(eventId: String) { preferences.edit().remove("pending-call:$eventId").apply() }
    fun clearDirectory() = synchronized(STATE_LOCK) {
        invalidateRequests()
        DirectorySyncWorker.cancel(appContext)
        val edit = preferences.edit().remove(DIRECTORY_KEY).remove(CONSENT_KEY).remove("pc-relay-consent").remove("history-consent").putString("session-generation", java.util.UUID.randomUUID().toString())
        preferences.all.keys.filter { it.startsWith("pending-call:") }.forEach(edit::remove)
        edit.apply()
    }
    fun clearAll() = synchronized(STATE_LOCK) { invalidateRequests(); DirectorySyncWorker.cancel(appContext); preferences.edit().clear().putString("session-generation", java.util.UUID.randomUUID().toString()).apply() }

    // Device-only diagnostics contain a timestamp and outcome, never the caller's number/name.
    fun recordScreeningStatus(message: String) {
        try {
            val time = java.text.DateFormat.getDateTimeInstance().format(java.util.Date())
            preferences.edit().putString("screening-status", encrypt("$time · $message")).apply()
        } catch (_: Exception) { /* Diagnostics must never interfere with a call. */ }
    }
    fun lastScreeningStatus(): String? = try { preferences.getString("screening-status", null)?.let(::decrypt) } catch (_: Exception) { null }

    private fun encrypt(text: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(text.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    }

    private fun decryptOrClear(value: String): String? = try { decrypt(value) } catch (_: Exception) { clearAll(); null }
    private fun decrypt(value: String): String {
        val packed = Base64.decode(value, Base64.NO_WRAP)
        require(packed.size > IV_SIZE)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, packed.copyOfRange(0, IV_SIZE)))
        return String(cipher.doFinal(packed.copyOfRange(IV_SIZE, packed.size)), Charsets.UTF_8)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    companion object {
        private val STATE_LOCK = Any()
        private val ACTIVE_REQUESTS = mutableSetOf<java.net.HttpURLConnection>()
        private const val KEY_ALIAS = "business-assistant-phone-v1"
        private const val TOKEN_KEY = "refresh-token"
        private const val DIRECTORY_KEY = "customer-phone-directory"
        private const val CONSENT_KEY = "phone-directory-sync-consent"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_SIZE = 12
    }
}
