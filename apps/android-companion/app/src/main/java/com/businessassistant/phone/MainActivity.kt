package com.businessassistant.phone

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Spinner
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var store: SecurePhoneStore
    private lateinit var api: PhoneApi
    private lateinit var status: TextView
    private lateinit var directoryStatus: TextView
    private lateinit var email: EditText
    private lateinit var password: EditText
    private lateinit var phone: EditText
    private lateinit var memo: EditText
    private lateinit var organizationSpinner: Spinner
    private lateinit var matchSpinner: Spinner
    private lateinit var syncConsent: CheckBox
    private val organizations = mutableListOf<PhoneOrganization>()
    private val matches = mutableListOf<PhoneEntry>()
    private var previousOrganizationId: String? = null
    private var pendingCallerNumber: String? = null
    private var updatingDirectoryStatus=false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = SecurePhoneStore(this)
        api = PhoneApi(BuildConfig.API_BASE_URL, store)
        status = findViewById(R.id.statusText)
        directoryStatus = findViewById(R.id.directoryStatus)
        email = findViewById(R.id.emailInput)
        password = findViewById(R.id.passwordInput)
        phone = findViewById(R.id.phoneInput)
        memo = findViewById(R.id.memoInput)
        organizationSpinner = findViewById(R.id.organizationSpinner)
        matchSpinner = findViewById(R.id.matchSpinner)
        syncConsent = findViewById(R.id.syncConsent)
        findViewById<TextView>(R.id.serverText).text = "API: ${BuildConfig.API_BASE_URL}"

        findViewById<Button>(R.id.loginButton).setOnClickListener { login() }
        findViewById<Button>(R.id.logoutButton).setOnClickListener { logout() }
        findViewById<Button>(R.id.syncButton).setOnClickListener { syncDirectory() }
        findViewById<Button>(R.id.clearDirectoryButton).setOnClickListener { clearDirectory("전화번호부 동기화를 해제하고 기기 저장 데이터를 삭제했습니다.") }
        findViewById<Button>(R.id.roleButton).setOnClickListener { requestCallScreeningRole() }
        findViewById<Button>(R.id.contactCallsButton).setOnClickListener { requestContactCallsPermission() }
        findViewById<CheckBox>(R.id.pcRelayConsent).setOnCheckedChangeListener { button, checked ->
            if (updatingDirectoryStatus) return@setOnCheckedChangeListener
            val organization = selectedOrganization()
            if (checked && (organization == null || store.activeOrganizationId() != organization.id)) {
                button.isChecked = false
                showStatus("먼저 로그인 후 고객 번호를 동기화해 주세요.")
            } else if (organization != null) {
                store.setPcRelayConsent(organization.id, checked)
                updateDirectoryStatus()
                updatePhonePermissionStatus()
            }
        }
        findViewById<CheckBox>(R.id.historyConsent).setOnCheckedChangeListener { button, checked ->
            if (updatingDirectoryStatus) return@setOnCheckedChangeListener
            val organization = selectedOrganization()
            if (organization == null || (checked && !store.hasPcRelayConsent(organization.id))) {
                updatingDirectoryStatus = true
                button.isChecked = false
                updatingDirectoryStatus = false
                showStatus("먼저 고객 번호부 동기화와 PC 전송에 동의해 주세요.")
                return@setOnCheckedChangeListener
            }
            // Local withdrawal takes effect immediately, even when offline.
            if (!checked) store.setHistoryConsent(organization.id, 0)
            val generation = store.generation()
            button.isEnabled = false
            runTask("수신 기록 보관 동의를 서버에 반영 중…") {
                try {
                    PhoneApi(BuildConfig.API_BASE_URL, store, generation).setHistoryConsent(organization.id, checked)
                    runOnUiThread { showStatus(if (checked) "이후 수신한 고객 전화만 30일 보관합니다." else "서버 보관 동의를 철회했습니다. 기존 기록은 원래 보유기간에 만료됩니다.") }
                } finally {
                    runOnUiThread { button.isEnabled = true; updateDirectoryStatus() }
                }
            }
        }
        findViewById<Button>(R.id.historyRevokeButton).setOnClickListener {
            val organization = selectedOrganization() ?: return@setOnClickListener showStatus("먼저 로그인해 주세요.")
            store.setHistoryConsent(organization.id, 0)
            updateDirectoryStatus()
            val generation = store.generation()
            runTask("서버 보관 동의 철회 재시도 중…") {
                PhoneApi(BuildConfig.API_BASE_URL, store, generation).setHistoryConsent(organization.id, false)
                runOnUiThread { updateDirectoryStatus(); showStatus("서버 보관 동의를 철회했습니다. 기존 기록은 원래 보유기간에 만료됩니다.") }
            }
        }
        findViewById<Button>(R.id.identifyButton).setOnClickListener { identify(phone.text.toString()) }
        findViewById<Button>(R.id.saveMemoButton).setOnClickListener { saveMemo() }
        syncConsent.setOnCheckedChangeListener { _, checked ->
            if (!checked && !updatingDirectoryStatus) clearDirectory("동기화 동의가 꺼져 기기 번호부를 삭제했습니다.")
        }
        organizationSpinner.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
            override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) {
                val selected = organizations.getOrNull(position)?.id ?: return
                if (previousOrganizationId != null && previousOrganizationId != selected) {
                    store.clearDirectory()
                    directoryStatus.text = "매장이 바뀌어 이전 매장 번호부를 삭제했습니다. 새 매장 동기화에 동의해 주세요."
                    syncConsent.isChecked = false
                }
                previousOrganizationId = selected
                updateDirectoryStatus()
            }
        }
        handleCallerIntent(intent)
        restoreSession()
        androidx.work.WorkManager.getInstance(this).getWorkInfosByTagLiveData("customer-directory-sync").observe(this) { updateDirectoryStatus() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCallerIntent(intent)
    }

    override fun onResume() { super.onResume(); updateDirectoryStatus(); updatePhonePermissionStatus(); store.activeOrganizationId()?.let { DirectorySyncWorker.schedule(this,it) } }

    private fun login() = runTask("로그인 중…") {
        api.login(email.text.toString().trim(), password.text.toString())
        runOnUiThread { password.text.clear() }
        loadOrganizationsFromApi()
    }

    private fun restoreSession() {
        worker.execute {
            if (api.restoreSession()) runOnUiThread { loadOrganizations() }
        }
    }

    private fun loadOrganizations() = runTask("연결된 매장을 불러오는 중…") {
        loadOrganizationsFromApi()
    }

    private fun loadOrganizationsFromApi() {
        val loaded = api.organizations()
        organizations.clear(); organizations.addAll(loaded)
        runOnUiThread {
            val adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, organizations.map { it.name })
            adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
            organizationSpinner.adapter = adapter
            val savedOrganization = store.activeOrganizationId()
            val savedIndex = organizations.indexOfFirst { it.id == savedOrganization }
            if (savedIndex >= 0) organizationSpinner.setSelection(savedIndex)
            findViewById<Button>(R.id.logoutButton).visibility = View.VISIBLE
            previousOrganizationId = organizations.getOrNull(organizationSpinner.selectedItemPosition)?.id
            updateDirectoryStatus()
            pendingCallerNumber?.let { caller ->
                pendingCallerNumber = null
                phone.setText(caller)
                identify(caller)
            }
        }
    }

    private fun syncDirectory() {
        val organization = selectedOrganization() ?: return showStatus("먼저 로그인하고 매장을 선택해 주세요.")
        if (!syncConsent.isChecked) return showStatus("번호부 동기화에 동의한 뒤 진행해 주세요.")
        val generation=store.generation()
        store.saveSyncConsent(organization.id,generation)
        runTask("고객 전화번호부 동기화 중…") {
            PhoneApi(BuildConfig.API_BASE_URL,store,generation).syncDirectory(organization.id)
            DirectorySyncWorker.schedule(this,organization.id)
            runOnUiThread { updateDirectoryStatus(); updatePhonePermissionStatus() }
        }
    }

    private fun clearDirectory(message: String) {
        store.clearDirectory()
        updateDirectoryStatus()
        showStatus(message)
    }

    private fun requestCallScreeningRole() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return showStatus("전화 식별은 Android 10 이상에서 지원합니다.")
        val manager = getSystemService(Context.ROLE_SERVICE) as RoleManager
        if (!manager.isRoleAvailable(RoleManager.ROLE_CALL_SCREENING)) return showStatus("이 기기에서는 통화 선별 역할을 제공하지 않습니다.")
        if (manager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)) return showStatus("수신 전화 고객 식별 권한이 이미 켜져 있습니다.")
        startActivityForResult(manager.createRequestRoleIntent(RoleManager.ROLE_CALL_SCREENING), REQUEST_CALL_ROLE)
    }

    @Deprecated("RoleManager callback kept for broad Android compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_CALL_ROLE) showStatus(if (resultCode == Activity.RESULT_OK) "전화 식별 권한을 켰습니다." else "권한이 켜지지 않았습니다. 설정에서 다시 허용할 수 있습니다.")
        updatePhonePermissionStatus()
    }

    private fun requestContactCallsPermission() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED) {
            updatePhonePermissionStatus()
            return showStatus("연락처에 저장된 번호도 전화 식별 대상으로 설정되어 있습니다.")
        }
        AlertDialog.Builder(this)
            .setTitle("연락처에 저장된 번호도 식별할까요?")
            .setMessage("Android는 연락처 접근 권한을 허용한 통화 선별 앱에만 저장된 연락처의 수신 전화도 전달합니다. 이 권한은 선택이며, 앱은 휴대폰 연락처 목록을 읽거나 서버로 전송하지 않습니다. 거부하면 연락처에 없는 번호의 고객 전화만 식별합니다. 언제든 Android 앱 권한 설정에서 해제할 수 있습니다.")
            .setNegativeButton("지금은 안 함", null)
            .setPositiveButton("권한 요청") { _, _ ->
                ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.READ_CONTACTS), REQUEST_CONTACT_CALLS)
            }.show()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        updatePhonePermissionStatus()
        if (requestCode == REQUEST_CONTACT_CALLS) {
            showStatus(if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) "저장된 연락처의 고객 전화도 식별합니다. 고객 번호 동기화와 전화 식별 역할도 켜져 있어야 합니다." else "연락처에 없는 번호만 식별합니다. 앱 설정에서 연락처 권한을 허용할 수 있습니다.")
        }
    }

    private fun updatePhonePermissionStatus() {
        val manager = getSystemService(Context.ROLE_SERVICE) as RoleManager
        val role = manager.isRoleHeld(RoleManager.ROLE_CALL_SCREENING)
        val contacts = ContextCompat.checkSelfPermission(this, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED
        val relay = selectedOrganization()?.id?.let { store.hasPcRelayConsent(it) } == true
        findViewById<TextView>(R.id.phonePermissionStatus).text = "전화 식별 역할: ${if (role) "켜짐" else "꺼짐"}\nPC 알림 전송: ${if (relay) "켜짐 — PC도 같은 계정·매장으로 로그인해 주세요" else "꺼짐 — 번호 동기화 후 전송에 동의해 주세요"}\n저장된 연락처: ${if (contacts) "식별 대상에 포함" else "제외 — 선택 권한 허용 시 포함"}"
        findViewById<TextView>(R.id.phonePermissionStatus).append("\n최근 수신 확인: ${store.lastScreeningStatus() ?: "아직 Android 수신 이벤트 없음"}")
    }

    private fun identify(number: String) {
        val organization = selectedOrganization() ?: return showStatus("먼저 로그인하고 매장을 선택해 주세요.")
        runTask("번호 확인 중…") {
            val found = api.identify(organization.id, number)
            matches.clear(); matches.addAll(found)
            runOnUiThread {
                val labels = matches.map { "${it.name} · ${it.phone}" }.ifEmpty { listOf("일치하는 고객 없음") }
                matchSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, labels).also { it.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item) }
                showStatus(if (matches.isEmpty()) "등록된 활성 고객과 일치하지 않습니다." else if (matches.size > 1) "같은 번호의 고객이 여러 명입니다. 저장할 고객을 선택해 주세요." else "고객을 확인했습니다.")
            }
        }
    }

    private fun saveMemo() {
        val organization = selectedOrganization() ?: return showStatus("먼저 로그인하고 매장을 선택해 주세요.")
        val customer = matches.getOrNull(matchSpinner.selectedItemPosition) ?: return showStatus("번호를 먼저 확인하고 고객을 선택해 주세요.")
        val note = memo.text.toString().trim()
        if (note.isEmpty()) return showStatus("통화 메모를 입력해 주세요.")
        runTask("메모 저장 중…") {
            api.saveMemo(organization.id, customer, phone.text.toString(), note)
            runOnUiThread { memo.text.clear(); showStatus("${customer.name} 고객 활동에 통화 메모를 저장했습니다.") }
        }
    }

    private fun logout() {
        api.logout()
        organizations.clear(); matches.clear()
        organizationSpinner.adapter = null; matchSpinner.adapter = null
        findViewById<Button>(R.id.logoutButton).visibility = View.GONE
        findViewById<EditText>(R.id.passwordInput).text.clear()
        updatingDirectoryStatus = true
        try {
            syncConsent.isChecked = false
            findViewById<CheckBox>(R.id.pcRelayConsent).isChecked = false
            findViewById<CheckBox>(R.id.historyConsent).isChecked = false
        } finally { updatingDirectoryStatus = false }
        previousOrganizationId = null
        directoryStatus.text = "로그아웃되어 기기 저장 번호부와 refresh token을 삭제했습니다."
        showStatus("로그아웃했습니다.")
    }

    private fun handleCallerIntent(intent: Intent?) {
        val caller = intent?.getStringExtra(EXTRA_CALLER_NUMBER) ?: return
        pendingCallerNumber = caller
        phone.setText(caller)
        if (organizations.isNotEmpty()) {
            pendingCallerNumber = null
            identify(caller)
        }
        else showStatus("수신 번호를 확인했습니다. 로그인 완료 후 고객을 조회할 수 있습니다.")
        intent.removeExtra(EXTRA_CALLER_NUMBER)
    }

    private fun selectedOrganization(): PhoneOrganization? = organizations.getOrNull(organizationSpinner.selectedItemPosition)

    private fun updateDirectoryStatus() {
        val organizationId = selectedOrganization()?.id ?: return
        val entries = store.loadDirectory(organizationId)
        updatingDirectoryStatus=true
        try {
            syncConsent.isChecked = store.hasSyncConsent(organizationId)
            findViewById<CheckBox>(R.id.pcRelayConsent).isChecked = store.hasPcRelayConsent(organizationId)
            findViewById<CheckBox>(R.id.historyConsent).isChecked = store.historyConsentVersion(organizationId) > 0
        } finally { updatingDirectoryStatus=false }
        val syncedAt=store.lastDirectorySyncAt(organizationId)
        val stamp=if(syncedAt>0) java.text.DateFormat.getDateTimeInstance().format(java.util.Date(syncedAt)) else "기록 없음"
        val stale=DirectorySyncPolicy.isStale(syncedAt,System.currentTimeMillis())
        directoryStatus.text = if (!store.hasSyncConsent(organizationId)) "이 매장의 전화번호부가 동기화되지 않았습니다." else "암호화된 기기 번호부: ${entries.size}명\n마지막 동기화: $stamp\n${if(stale) "오래된 번호부 — 인터넷 연결 후 자동 갱신을 기다리거나 다시 동기화하세요." else "자동 갱신 사용 중 · 약 15분 주기(배터리·네트워크 상태에 따라 지연)"}"
    }

    private fun runTask(message: String, task: () -> Unit) {
        showStatus(message)
        worker.execute {
            try { task() } catch (error: Exception) { runOnUiThread { showStatus(error.message ?: "요청에 실패했습니다. 다시 시도해 주세요.") } }
        }
    }

    private fun showStatus(message: String) { status.text = message }

    override fun onDestroy() { worker.shutdownNow(); super.onDestroy() }

    companion object {
        const val EXTRA_CALLER_NUMBER = "com.businessassistant.phone.CALLER_NUMBER"
        private const val REQUEST_CALL_ROLE = 2201
        private const val REQUEST_CONTACT_CALLS = 2203
    }
}
