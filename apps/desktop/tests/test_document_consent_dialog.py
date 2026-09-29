from copy import deepcopy
from uuid import uuid4

from business_assistant_desktop.document_consent_dialog import DocumentConsentDialog
from PySide6.QtWidgets import QMessageBox


class Client:
    def __init__(self):
        self.events = []
        self.calls = []
        self.fail = False

    def list_document_consent_events(self, *args):
        return deepcopy(self.events)

    def record_document_consent_event(self, org, customer, treatment, doc, payload):
        self.calls.append(deepcopy(payload))
        if self.fail:
            raise RuntimeError("offline")
        event = {
            "id": str(uuid4()),
            "revision": len(self.events) + 1,
            "action": payload["action"],
            "values": payload["values"],
            "actor_id": str(uuid4()),
            "occurred_at": "2026-09-23T00:00:00Z",
            "content_hash": "a" * 64,
        }
        self.events.append(event)
        return event


def setup(qtbot, can_manage=True):
    client = Client()
    doc = {
        "id": str(uuid4()),
        "title": "동의서",
        "content": "<b>보존할 원문</b>",
        "template_version": 1,
        "source_snapshot": {},
    }
    w = DocumentConsentDialog(client, uuid4(), uuid4(), uuid4(), doc, can_manage=can_manage)
    qtbot.addWidget(w)
    qtbot.waitUntil(lambda: not w.busy)
    return w, client


def fill_signature(w):
    w.signer.setText("홍길동")
    w.pad.set_strokes([[[0.1, 0.2], [0.4, 0.5]]])
    w.sign_confirm.setChecked(True)


def test_sign_then_delivery_then_revoke_preserves_evidence(qtbot):
    w, c = setup(qtbot)
    assert w.body.toPlainText() == "<b>보존할 원문</b>"
    fill_signature(w)
    w.save("sign")
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0]["values"]["strokes"] == [[[0.1, 0.2], [0.4, 0.5]]]
    assert not w.pad.isEnabled()
    w.recipient.setText("홍길동")
    w.delivery_confirm.setChecked(True)
    w.save("deliver")
    qtbot.waitUntil(lambda: not w.busy)
    w.reason.setPlainText("고객 요청")
    w.revoke_confirm.setChecked(True)
    w.save("revoke")
    qtbot.waitUntil(lambda: not w.busy)
    assert [e["action"] for e in c.events] == ["sign", "deliver", "revoke"]
    assert "철회" in w.state.text()
    assert w.pad.has_ink()
    assert not w.buttons["deliver"].isEnabled()


def test_failed_sign_keeps_ink_and_exact_retry(qtbot, monkeypatch):
    w, c = setup(qtbot)
    fill_signature(w)
    c.fail = True
    w.save("sign")
    qtbot.waitUntil(lambda: not w.busy)
    assert w.pad.has_ink()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.confirm_leave()
    c.fail = False
    w.retry()
    qtbot.waitUntil(lambda: not w.busy)
    assert c.calls[0] == c.calls[1]


def test_member_and_unconfirmed_empty_signature_cannot_save(qtbot):
    w, c = setup(qtbot, False)
    w.save("sign")
    assert c.calls == []
    w, c = setup(qtbot)
    w.signer.setText("이름")
    w.save("sign")
    assert c.calls == []
    w.signer.clear()


def test_window_close_cancellation_keeps_signature(qtbot, monkeypatch):
    w, _ = setup(qtbot)
    w.show()
    fill_signature(w)
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Cancel)
    assert not w.close()
    assert w.pad.has_ink()
    monkeypatch.setattr(QMessageBox, "question", lambda *a, **k: QMessageBox.StandardButton.Discard)
    with qtbot.waitSignal(w.finished):
        w.close()


def test_saving_delivery_keeps_unsubmitted_withdrawal_text(qtbot):
    w, _ = setup(qtbot)
    fill_signature(w)
    w.save("sign")
    qtbot.waitUntil(lambda: not w.busy)
    w.reason.setPlainText("작성 중인 철회 사유")
    w.recipient.setText("고객")
    w.delivery_confirm.setChecked(True)
    w.save("deliver")
    qtbot.waitUntil(lambda: not w.busy)
    assert w.reason.toPlainText() == "작성 중인 철회 사유"
    assert w.dirty()
    w.reason.clear()


def test_signature_resize_keeps_normalized_evidence(qtbot):
    from business_assistant_desktop.signature_pad import SignaturePad

    pad = SignaturePad()
    qtbot.addWidget(pad)
    points = [[[0.1, 0.2], [0.6, 0.8]]]
    pad.set_strokes(points)
    pad.resize(600, 300)
    assert pad.strokes() == points
    copy = pad.strokes()
    copy[0][0][0] = 1
    assert pad.strokes() == points
