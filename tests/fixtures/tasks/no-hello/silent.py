"""A connector process that never sends hello: it waits until it is killed."""

import time

while True:
    time.sleep(60)
