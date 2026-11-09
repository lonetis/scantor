from pydantic import BaseModel


class Result(BaseModel):
    item: str
    length: int
