# copilot-remote

- `npm run build` IS the deploy. `dist/index.js` write triggers RestartManager auto-restart. Never `systemctl restart`.
- `npm test` = `tsx --test src/**/*.test.ts` (~10s). Pre-existing lint errors are noise.
