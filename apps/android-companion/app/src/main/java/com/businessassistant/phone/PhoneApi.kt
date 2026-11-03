package com.businessassistant.phone

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

data class PhoneOrganization(val id: String, val name: String)
class PhoneApiError(val status: Int, message: String) : IllegalStateException(message)

class PhoneApi(private val baseUrl: String, private val secureStore: SecurePhoneStore, private val expectedGeneration: String? = null) {
    @Volatile private var accessToken: String? = null
    private val apiRoot = baseUrl.trimEnd('/') + "/"

    fun login(email: String, password: String) {
        secureStore.clearDirectory()
        accessToken=null
        val generation=secureStore.generation()
        val session = request("POST", "auth/login", JSONObject().put("email", email).put("password", password), authenticated = false)
        acceptSession(session,generation)
    }

    fun restoreSession(): Boolean = try {
        refreshSession()
        true
    } catch (_: Exception) { false }

    fun organizations(): List<PhoneOrganization> {
        val rows = request("GET", "organizations").getJSONArray("items")
        return (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            PhoneOrganization(row.getString("id"), row.getString("name"))
        }
    }

    fun syncDirectory(organizationId: String): List<PhoneEntry> = synchronized(DIRECTORY_SYNC_LOCK) {
        val generation=expectedGeneration ?: secureStore.generation()
        val deadline=PhoneRequestDeadline(now={android.os.SystemClock.elapsedRealtime()})
        val result=DirectorySyncEngine.sync(secureStore.loadDirectorySnapshot(organizationId),fetch={ cursor ->
            val suffix=cursor?.let { "?cursor=${java.net.URLEncoder.encode(it, Charsets.UTF_8.name())}" } ?: ""
            val page=deadline.await { request("GET","organizations/$organizationId/mobile/phone-directory-sync$suffix",deadline=deadline) }
            check(page.getString("organization_id")==organizationId)
            val rows = page.getJSONArray("items")
            check(rows.length()<=200)
            val changes=(0 until rows.length()).map { index ->
                val row=rows.getJSONObject(index);val id=row.getString("customer_id");val operation=row.getString("operation")
                check(operation in listOf("upsert","delete"))
                val entry=if(operation=="upsert")PhoneEntry(id,row.getString("name"),row.getString("phone"),row.getString("phone_e164")) else null
                if(entry!=null)check(PhoneMatcher.normalize(entry.phone)==entry.phoneE164)
                DirectoryChange(id,entry,if(row.has("revision"))row.getString("revision").toLong() else null)
            }
            fun token(key:String)=page.optString(key).takeIf { it.isNotBlank() && it!="null" }
            DirectoryPage(page.getString("mode"),changes,page.getString("revision").toLong(),token("next_cursor"),token("cursor"),page.getBoolean("reset_required"))
        },stillAllowed={deadline.remainingMillis();secureStore.generation()==generation && secureStore.hasSyncConsent(organizationId)},commit={snapshot -> deadline.remainingMillis();secureStore.saveDirectory(organizationId,snapshot.entries,generation,snapshot.cursor,snapshot.revision)})
        result.entries
    }

    fun identify(organizationId: String, number: String): List<PhoneEntry> {
        val response = request("POST", "organizations/$organizationId/mobile/phone-identification", JSONObject().put("number", number))
        val rows = response.getJSONArray("matches")
        return (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            PhoneEntry(row.getString("customer_id"), row.getString("name"), row.getString("phone"), row.getString("phone_e164"))
        }
    }

    fun saveMemo(organizationId: String, customer: PhoneEntry, number: String, memo: String) {
        request("POST", "organizations/$organizationId/mobile/phone-memos", JSONObject()
            .put("customer_id", customer.customerId).put("phone", number).put("memo", memo)
            .put("occurred_at", java.time.Instant.now().toString()))
    }

    fun logout() {
        accessToken = null
        secureStore.clearAll()
    }

    fun relayCall(organizationId: String, eventId: String, number: String, occurredAt: String, queuedHistoryVersion: Int = 0) {
        val body = JSONObject().put("event_id", eventId).put("number", number).put("occurred_at", occurredAt)
        CallRelayPolicy.historyVersion(queuedHistoryVersion, secureStore.historyConsentVersion(organizationId))?.let { body.put("retention_consent_version", it) }
        request("POST", "organizations/$organizationId/mobile/incoming-calls", body)
    }

    fun setHistoryConsent(organizationId: String, enabled: Boolean): Int {
        val generation = secureStore.generation()
        val current = request("GET", "organizations/$organizationId/mobile/phone-retention-consent")
        val saved = request("PUT", "organizations/$organizationId/mobile/phone-retention-consent", JSONObject().put("enabled", enabled).put("expected_version", current.getInt("version")).put("operation_id", java.util.UUID.randomUUID().toString()))
        check(secureStore.generation() == generation) { "전화 연동 상태가 변경됐습니다." }
        val version = if (saved.getBoolean("enabled")) saved.getInt("version") else 0
        secureStore.setHistoryConsent(organizationId, version, generation)
        return version
    }

    private fun request(method: String, path: String, body: JSONObject? = null, authenticated: Boolean = true, retry: Boolean = true, deadline: PhoneRequestDeadline? = null): JSONObject {
        deadline?.remainingMillis()
        check(expectedGeneration == null || secureStore.generation() == expectedGeneration) { "로그인 또는 전화 연동 상태가 변경됐습니다." }
        val requestGeneration = expectedGeneration ?: secureStore.generation()
        if (authenticated && accessToken == null) refreshSession(deadline)
        val connection = (URL(apiRoot + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = minOf(8_000,deadline?.remainingMillis() ?: 8_000)
            readTimeout = minOf(8_000,deadline?.remainingMillis() ?: 8_000)
            setRequestProperty("Accept", "application/json")
            body?.let {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
            if (authenticated) setRequestProperty("Authorization", "Bearer ${accessToken ?: throw IllegalStateException("다시 로그인해 주세요.")}")
        }
        val response: JSONObject
        val status: Int
        secureStore.registerRequest(connection, requestGeneration)
        try {
            deadline?.remainingMillis()
            check(secureStore.generation() == requestGeneration) { "전화 연동 상태가 변경됐습니다." }
            body?.let { connection.outputStream.use { stream -> stream.write(it.toString().toByteArray(Charsets.UTF_8)) } }
            status = connection.responseCode
            if (status == 401 && authenticated && retry) {
                connection.disconnect()
                check(secureStore.generation() == requestGeneration) { "전화 연동 상태가 변경됐습니다." }
                refreshSession(deadline)
                check(secureStore.generation() == requestGeneration) { "전화 연동 상태가 변경됐습니다." }
                return request(method, path, body, authenticated, retry = false, deadline=deadline)
            }
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { reader ->
                val output=StringBuilder();val buffer=CharArray(8192)
                while(true){deadline?.let { connection.readTimeout=minOf(8_000,it.remainingMillis()) };val count=reader.read(buffer);deadline?.remainingMillis();if(count<0)break;check(output.length+count<=2_000_000) { "API 응답이 너무 큽니다." };output.append(buffer,0,count)}
                output.toString()
            }.orEmpty()
            response = if (text.isBlank()) JSONObject() else if (text.trimStart().startsWith('[')) JSONObject().put("items", JSONArray(text)) else JSONObject(text)
        } finally { secureStore.finishRequest(connection); connection.disconnect() }
        deadline?.remainingMillis()
        check(secureStore.generation() == requestGeneration) { "전화 연동 상태가 변경됐습니다." }
        if (status !in 200..299) {
            val detail = response.optString("detail").ifBlank { response.optString("message") }.ifBlank { "API 요청에 실패했습니다 ($status)." }
            throw PhoneApiError(status, detail)
        }
        return response
    }

    private fun refreshSession(deadline: PhoneRequestDeadline? = null) = synchronized(TOKEN_LOCK) {
        deadline?.remainingMillis()
        val generation=expectedGeneration ?: secureStore.generation()
        val refreshToken = secureStore.loadRefreshToken() ?: throw IllegalStateException("로그인이 필요합니다.")
        val session = request("POST", "auth/refresh", JSONObject().put("refresh_token", refreshToken), authenticated = false, deadline=deadline)
        deadline?.remainingMillis()
        acceptSession(session,generation)
    }

    private fun acceptSession(session: JSONObject, generation: String) {
        check(secureStore.generation()==generation) { "로그인 상태가 변경됐습니다." }
        val next=session.getString("access_token")
        session.optString("refresh_token").takeIf { it.isNotBlank() && it != "null" }?.let { secureStore.saveRefreshToken(it, generation) }
        check(secureStore.generation()==generation) { "로그인 상태가 변경됐습니다." }
        accessToken=next
    }
    companion object { private val TOKEN_LOCK=Any(); private val DIRECTORY_SYNC_LOCK=Any() }
}
