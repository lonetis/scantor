"""Entry point of a connector process: `python -m scantor.serve <entry>` (SCANTOR_CONNECTOR_CMD).

It speaks the connector protocol on fds 3 and 4 and is started by the scantor runtime; run tasks with
`scantor dev run`, not directly.
"""

from scantor._server import exit_process, main

if __name__ == "__main__":
    exit_process(main())
