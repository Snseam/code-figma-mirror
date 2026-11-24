const entries = [
  { id: 'river', title: 'North river', area: 'Water survey', detail: 'Collect a second sample from the footbridge.' },
  { id: 'ridge', title: 'Cedar ridge', area: 'Trail survey', detail: 'Check the marker at the eastern fork.' },
  { id: 'quarry', title: 'Old quarry', area: 'Soil survey', detail: 'The samples are catalogued and ready for review.' }
];

function action(label, target, id) {
  return `<button id="${id}" class="action" data-component="Action" data-target="${target}">${label}</button>`;
}

function tab(label, target, current) {
  const selected = target === current;
  return `<button class="tab" id="tab-${target}" data-component="Tab" data-variant="${selected ? 'Selected' : 'Rest'}" aria-pressed="${selected}" data-target="${target}">${label}</button>`;
}

function draw() {
  const current = location.hash.slice(1) || 'open';
  const entry = entries.find(item => item.id === current);
  const app = document.getElementById('app');
  if (entry) {
    const origin = entry.id === 'quarry' ? 'closed' : 'open';
    app.innerHTML = `<h1>Survey detail</h1><section class="detail" id="detail-${entry.id}"><h2>${entry.title}</h2><p>${entry.detail}</p>${action('Back to surveys', origin, 'return')}</section>`;
    return;
  }
  const list = current === 'closed' ? entries.slice(2) : entries.slice(0, 2);
  const cards = list.map(item => `<article id="card-${item.id}" data-component="Survey card"><h2>${item.title}</h2><p>${item.area}</p>${action('View survey', item.id, `open-${item.id}`)}</article>`).join('');
  app.innerHTML = `<h1>Surveys</h1><nav aria-label="Survey status">${tab('Open', 'open', current)}${tab('Closed', 'closed', current)}</nav><section class="list" id="list-${current}">${cards}</section>`;
}

document.getElementById('app').addEventListener('click', event => {
  const button = event.target.closest('button[data-target]');
  if (button) location.hash = button.dataset.target;
});
window.addEventListener('hashchange', draw);
draw();
