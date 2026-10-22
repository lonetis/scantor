import scantor


def run(ctx: scantor.Context, analysis_config: scantor.Empty, task_config: scantor.Empty) -> dict[str, str]:
    return {}


task = scantor.Task(result=dict, run=run)  # pyright: ignore[reportArgumentType]
