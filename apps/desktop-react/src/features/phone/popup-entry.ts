import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { CallPopup } from '../../platform/types';
import './popup.css';
import { renderPopupSummary } from './popup-summary';

const root = document.querySelector<HTMLElement>('#calls')!;
const status = document.querySelector<HTMLElement>('#status')!;
const cards = new Map<string, HTMLElement>();
let reading = false;
async function refresh() {
  if (reading) return;
  reading = true;
  try {
    const calls = await invoke<CallPopup[]>('call_popup_read');
    const fresh = calls.filter(call => call.expiresAt > Date.now()).reverse();
    for (const [id, card] of cards) if (!fresh.some(call => call.id === id)) { card.remove(); cards.delete(id); }
    for (const [index, call] of fresh.entries()) {
      if (!cards.has(call.id)) {
        const card = document.createElement('section');
        card.className = 'call';
        const label = document.createElement('header'); label.textContent = '☎  고객 전화 수신';
        const name = document.createElement('strong'); name.textContent = call.title;
        const phone = document.createElement('p'); phone.textContent = call.phone;
        const actions = document.createElement('footer');
        for (const customer of call.customers ?? []) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = call.customers!.length === 1 ? '고객 상세 보기' : `${customer.name} 상세 보기`;
          button.onclick = async () => {
            button.disabled = true;
            try { await invoke('call_popup_action', { id: call.id, memo: false, action: 'customer', customerId: customer.id }); await refresh(); }
            catch { status.textContent = '고객 화면을 열지 못했습니다. PC 앱에서 확인해 주세요.'; }
            finally { button.disabled = false; }
          };
          actions.append(button);
        }
        for (const [text, memo] of [['메모 작성', true], ['닫기', false]] as const) {
          const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
          button.onclick = async () => {
            button.disabled = true;
            try { await invoke('call_popup_action', { id: call.id, memo }); await refresh(); }
            catch { status.textContent = '처리하지 못했습니다. PC 앱에서 확인해 주세요.'; }
            finally { button.disabled = false; }
          };
          actions.append(button);
        }
        const summary = document.createElement('div'); summary.className = 'call-summary';
        card.append(label, name, phone, summary, actions); cards.set(call.id, card);
      }
      const card = cards.get(call.id)!;
      card.querySelector('strong')!.textContent=call.title;
      card.querySelector('p')!.textContent=call.phone;
      renderPopupSummary(card.querySelector<HTMLElement>('.call-summary')!, call.summary, () => {
        void invoke('call_popup_action', { id: call.id, memo: false, action: 'retry' }).catch(() => { status.textContent = '다시 불러오지 못했습니다. 잠시 후 재시도하세요.'; });
      });
      if (root.children[index] !== card) root.insertBefore(card, root.children[index] ?? null);
    }
  } catch { root.replaceChildren(); cards.clear(); status.textContent = '전화 알림 연결을 확인하고 있습니다.'; }
  finally { reading = false; }
}
await listen('call-popup:update', () => void refresh());
await refresh();
setInterval(() => void refresh(), 1000);
