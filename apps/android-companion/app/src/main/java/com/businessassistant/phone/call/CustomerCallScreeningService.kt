package com.businessassistant.phone.call

import android.os.Build
import android.telecom.Call
import android.telecom.CallScreeningService
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.workDataOf
import com.businessassistant.phone.PhoneMatcher
import com.businessassistant.phone.CallRelayPolicy
import com.businessassistant.phone.SecurePhoneStore
import java.time.Instant
import java.util.concurrent.TimeUnit

/** Never performs a network request in the call decision path: answer Telecom first, then use the local encrypted index. */
class CustomerCallScreeningService : CallScreeningService() {
    override fun onScreenCall(details: Call.Details) {
        val allow = CallResponse.Builder()
            .setDisallowCall(false)
            .setRejectCall(false)
            .setSkipCallLog(false)
            .setSkipNotification(false)
            .build()
        respondToCall(details, allow)

        if (details.callDirection != Call.Details.DIRECTION_INCOMING) return
        val store = SecurePhoneStore(this)
        store.recordScreeningStatus("Android 수신 이벤트 도착")
        val number = details.handle?.schemeSpecificPart ?: run { store.recordScreeningStatus("수신 번호가 전달되지 않음"); return }
        val organizationId = store.activeOrganizationId() ?: run { store.recordScreeningStatus("기기 번호부 동기화 필요"); return }
        if(com.businessassistant.phone.DirectorySyncPolicy.isStale(store.lastDirectorySyncAt(organizationId),System.currentTimeMillis())) {
            store.recordScreeningStatus("번호부가 오래되어 PC 전송을 보류했습니다. 번호부 갱신 후 다시 테스트하세요.")
            com.businessassistant.phone.DirectorySyncWorker.schedule(this,organizationId)
            return
        }
        val matches = PhoneMatcher.find(number, store.loadDirectory(organizationId))
        if (matches.isEmpty()) { store.recordScreeningStatus("기기 번호부에서 일치 고객 없음 — 다시 동기화해 주세요"); return }
        if (!store.hasPcRelayConsent(organizationId)) { store.recordScreeningStatus("고객 일치, PC 알림 전송 동의가 꺼져 있음"); return }
        val createdAt = details.creationTimeMillis.takeIf { it > 0 } ?: System.currentTimeMillis()
        val eventId = CallRelayPolicy.eventId(organizationId, PhoneMatcher.normalize(number) ?: return, createdAt)
        if (!store.queueCall(eventId, organizationId, number, Instant.ofEpochMilli(createdAt).toString())) return
        val builder = OneTimeWorkRequestBuilder<CallRelayWorker>()
            .setInputData(workDataOf("event_id" to eventId))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
        if (Build.VERSION.SDK_INT >= 31) builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        store.recordScreeningStatus("PC 알림 전송 작업 예약됨")
        WorkManager.getInstance(this).enqueueUniqueWork("pc-call-$eventId", ExistingWorkPolicy.KEEP, builder.build())
    }
}
