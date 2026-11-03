package com.businessassistant.phone

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

/** Work data contains an organization ID only. Customer data stays encrypted on device. */
class DirectorySyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val organizationId = inputData.getString("organization_id") ?: return Result.failure()
        val store = SecurePhoneStore(applicationContext)
        if (!eligible(store, organizationId)) return Result.success()
        val generation = store.generation()
        return try {
            PhoneApi(BuildConfig.API_BASE_URL, store, generation).syncDirectory(organizationId)
            Result.success()
        } catch (error: Exception) {
            if (!eligible(store, organizationId) || store.generation() != generation) return Result.success()
            if (error is PhoneApiError && error.status in listOf(401, 403, 404, 422)) Result.failure() else Result.retry()
        }
    }

    companion object {
        private const val PERIODIC = "customer-directory-periodic"
        private const val REFRESH = "customer-directory-refresh"
        private fun eligible(store: SecurePhoneStore, org: String) = store.hasSyncConsent(org) && store.activeOrganizationId() == org
        fun schedule(context: Context, org: String) {
            val store = SecurePhoneStore(context)
            if (!eligible(store, org)) return
            val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            val data = workDataOf("organization_id" to org)
            val periodic = PeriodicWorkRequestBuilder<DirectorySyncWorker>(15, TimeUnit.MINUTES)
                .addTag("customer-directory-sync").setConstraints(constraints).setInputData(data).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
            val manager = WorkManager.getInstance(context)
            manager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, periodic)
            if (DirectorySyncPolicy.needsRefresh(store.lastDirectorySyncAt(org), System.currentTimeMillis())) {
                val refresh = OneTimeWorkRequestBuilder<DirectorySyncWorker>().addTag("customer-directory-sync").setConstraints(constraints).setInputData(data).build()
                manager.enqueueUniqueWork(REFRESH, ExistingWorkPolicy.KEEP, refresh)
            }
        }
        fun cancel(context: Context) {
            val manager = WorkManager.getInstance(context)
            manager.cancelUniqueWork(PERIODIC)
            manager.cancelUniqueWork(REFRESH)
        }
    }
}
