package com.businessassistant.phone.call

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.businessassistant.phone.BuildConfig
import com.businessassistant.phone.CallRelayPolicy
import com.businessassistant.phone.PhoneApi
import com.businessassistant.phone.PhoneApiError
import com.businessassistant.phone.SecurePhoneStore

/** WorkManager holds only an event ID. Caller details stay in the encrypted store. */
class CallRelayWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val eventId = inputData.getString("event_id") ?: return Result.failure()
        val store = SecurePhoneStore(applicationContext)
        val event = store.pendingCall(eventId) ?: return Result.success()
        return try {
            PhoneApi(BuildConfig.API_BASE_URL, store, event.getString("generation")).relayCall(event.getString("organization_id"), eventId, event.getString("number"), event.getString("occurred_at"), event.optInt("history_version", 0))
            store.removePendingCall(eventId)
            store.recordScreeningStatus("PC 알림 서버에 수신 전화 전달 완료 — 같은 계정·매장의 PC를 확인하세요")
            Result.success()
        } catch (error: Exception) {
            if (store.pendingCall(eventId) == null) return Result.success()
            if (error is PhoneApiError && !CallRelayPolicy.shouldRetry(error.status)) {
                store.removePendingCall(eventId)
                store.recordScreeningStatus("PC 전송 거부 (${error.status}) — 로그인·권한·고객 번호를 확인하세요")
                Result.failure()
            } else {
                store.recordScreeningStatus("PC 전송 대기 — 인터넷 연결 후 2분 이내 재시도")
                Result.retry()
            }
        }
    }
}
