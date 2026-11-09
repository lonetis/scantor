"""Entry point of a script run: `python -m scantor.script <entry>` (SCANTOR_SCRIPT_CMD).

The scantor runtime starts it in the script-run container (`scantor runtime script`); run scripts with
`scantor scripts run`, the web UI or MCP, not directly. Worker processes of `ctx.map` import this module
again (multiprocessing `spawn`), so it does nothing unless it is the main module.
"""

from scantor._entry import exit_process
from scantor.script._main import main

if __name__ == "__main__":
    exit_process(main())
