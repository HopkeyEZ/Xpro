export function initResizers(): void {
  setupHorizontalResizer('resizer-left', 'sidebar', 'left');
  setupVerticalResizer('resizer-bottom', 'panel');
}

function setupHorizontalResizer(resizerId: string, panelId: string, side: 'left' | 'right') {
  const resizer = document.getElementById(resizerId);
  const panel = document.getElementById(panelId);
  if (!resizer || !panel) return;

  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = panel.offsetWidth;
    resizer.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX;
      const newWidth = side === 'left' ? startWidth + dx : startWidth - dx;
      panel.style.width = `${Math.max(160, Math.min(newWidth, 600))}px`;
    };

    const onUp = () => {
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function setupVerticalResizer(resizerId: string, panelId: string) {
  const resizer = document.getElementById(resizerId);
  const panel = document.getElementById(panelId);
  if (!resizer || !panel) return;

  let startY = 0;
  let startHeight = 0;

  resizer.addEventListener('mousedown', (e) => {
    startY = e.clientY;
    startHeight = panel.offsetHeight;
    resizer.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e: MouseEvent) => {
      const dy = startY - e.clientY;
      panel.style.height = `${Math.max(60, Math.min(startHeight + dy, 500))}px`;
    };

    const onUp = () => {
      resizer.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
