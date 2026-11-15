"""A scheduled job: records when it last ran in the service user's data folder."""

import datetime
import os
import pathlib

stamp = pathlib.Path(os.environ["HOME"], "data", "python-api-last-run.txt")
stamp.write_text(datetime.datetime.now(datetime.timezone.utc).isoformat() + "\n")
print(f"wrote {stamp}")
