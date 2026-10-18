/** All months are rendered on the server. Switching makes no requests. */
export function initializeMonthChart(root: HTMLElement) {
  const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-calendar-month]'));
  const navigation = root.querySelector<HTMLElement>('.month-navigation');
  const previous = root.querySelector<HTMLButtonElement>('[data-previous-month]');
  const next = root.querySelector<HTMLButtonElement>('[data-next-month]');
  const label = root.querySelector<HTMLElement>('[data-selected-month]');
  if (!panels.length || !navigation || !previous || !next || !label) return;
  let selected = 0;
  const render = () => {
    panels.forEach((panel, index) => { panel.hidden = index !== selected; });
    label.textContent = panels[selected].dataset.monthLabel ?? '';
    previous.disabled = selected === panels.length - 1;
    next.disabled = selected === 0;
  };
  previous.addEventListener('click', () => { if (selected < panels.length - 1) { selected++; render(); } });
  next.addEventListener('click', () => { if (selected > 0) { selected--; render(); } });
  render();
  navigation.hidden = false;
}
