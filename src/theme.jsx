import { useState } from 'react';

// 'system' follows the OS setting; 'light'/'dark' force a theme via <html data-theme>.
// index.html applies the stored choice before first paint to avoid a flash.
const KEY = 'theme';
const OPTIONS = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function storedTheme() {
  try {
    return localStorage.getItem(KEY) || 'system';
  } catch {
    return 'system';
  }
}

function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage unavailable (e.g. private mode): the choice just won't persist.
  }
}

export function ThemeSwitch() {
  const [theme, setTheme] = useState(storedTheme);

  const choose = (value) => {
    applyTheme(value);
    setTheme(value);
  };

  return (
    <div className="theme-switch" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          className={theme === o.value ? 'active' : ''}
          aria-pressed={theme === o.value}
          onClick={() => choose(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
