Build a dependency-free browser dashboard that visualizes work moving through a small factory: resources enter, machines process them, and finished goods leave. Make the activity visible and the controls usable. Include pause/resume, a reset control, and a counter showing completed deliveries. Use original SVG or canvas graphics authored by the team.

Start from this brief and an empty task board. Decide the architecture, tasks and interfaces yourselves. Every worker may create tasks and ask peers for help. Coordinate overlapping edits through file leases and messages.

Implement the site in index.html plus modules/styles of your choice. Add meaningful Node built-in tests in tests/*.test.mjs. The app should run as static files with no external network dependencies. A green Node suite alone does not prove the browser works: document how a person can check rendering, pause/resume, reset and increasing deliveries. Do not claim those checks were performed unless they were.
