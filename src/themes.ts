export interface Theme {
  name: string
  fg: string       // default foreground hex
  bg: string       // default background hex
  palette: string[] // 16 ANSI color overrides (indices 0–15)
}

export const DEFAULT_THEME: Theme = {
  name: "default",
  fg: "#c0c0c0",
  bg: "#1e1e1e",
  palette: [
    "#000000", "#cd0000", "#00cd00", "#cdcd00",
    "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00",
    "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
  ],
}

export const DRACULA_THEME: Theme = {
  name: "dracula",
  fg: "#f8f8f2",
  bg: "#282a36",
  palette: [
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c",
    "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5",
    "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
  ],
}

export const MONOKAI_THEME: Theme = {
  name: "monokai",
  fg: "#f8f8f2",
  bg: "#272822",
  palette: [
    "#272822", "#f92672", "#a6e22e", "#f4bf75",
    "#66d9ef", "#ae81ff", "#a1efe4", "#f8f8f2",
    "#75715e", "#f92672", "#a6e22e", "#f4bf75",
    "#66d9ef", "#ae81ff", "#a1efe4", "#f9f8f5",
  ],
}

export const SOLARIZED_DARK_THEME: Theme = {
  name: "solarized-dark",
  fg: "#839496",
  bg: "#002b36",
  palette: [
    "#073642", "#dc322f", "#859900", "#b58900",
    "#268bd2", "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83",
    "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
  ],
}

export const THEMES: Record<string, Theme> = {
  default: DEFAULT_THEME,
  dracula: DRACULA_THEME,
  monokai: MONOKAI_THEME,
  "solarized-dark": SOLARIZED_DARK_THEME,
}

export function getTheme(name: string): Theme {
  return THEMES[name] ?? DEFAULT_THEME
}
