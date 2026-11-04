import type { AshiatoApi } from '../preload';

const api = (window as unknown as { ashiato: AshiatoApi }).ashiato;
const form = document.getElementById('f') as HTMLFormElement;
const input = document.getElementById('t') as HTMLInputElement;
const ok = document.getElementById('ok')!;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!input.value.trim()) return;
  await api.addMemo(input.value);
  input.value = '';
  ok.textContent = '記録しました';
  setTimeout(() => {
    ok.textContent = '';
    api.hideMemo();
  }, 600);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') api.hideMemo();
});
window.addEventListener('focus', () => input.focus());
