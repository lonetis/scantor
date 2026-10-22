export default defineAppConfig({
  ui: {
    colors: {
      primary: 'green',
      neutral: 'slate',
    },
    dashboardPanel: {
      slots: {
        // The body is a scrolling flex column: its direct children must overflow and scroll instead of being
        // squashed, which clipped alerts and cards (overflow-hidden lets them shrink below their content).
        body: '*:shrink-0',
      },
    },
  },
})
