import { useEffect, useState } from 'react';

const EDGE = 200; // px from the top/bottom within which that button is hidden

// Floating "jump to top / bottom" buttons. Each shows only when there's somewhere to
// jump to; jumps are instant because smooth-scrolling a 1,800-row list takes ages.
export default function ScrollButtons() {
  const [pos, setPos] = useState({ top: true, bottom: true });

  useEffect(() => {
    const update = () => {
      const el = document.documentElement;
      setPos({
        top: window.scrollY < EDGE,
        bottom: window.scrollY + window.innerHeight > el.scrollHeight - EDGE,
      });
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // Lists load and filter after mount, changing the page height.
    const observer = new ResizeObserver(update);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer.disconnect();
    };
  }, []);

  const jump = (top) => window.scrollTo({ top, behavior: 'instant' });

  return (
    <div className="scroll-buttons">
      {!pos.top && (
        <button onClick={() => jump(0)} title="Jump to top" aria-label="Jump to top">↑</button>
      )}
      {!pos.bottom && (
        <button
          onClick={() => jump(document.documentElement.scrollHeight)}
          title="Jump to bottom"
          aria-label="Jump to bottom"
        >
          ↓
        </button>
      )}
    </div>
  );
}
