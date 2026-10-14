from contextvars import ContextVar

request_id_var: ContextVar[str] = ContextVar("talaeats_request_id", default="")
request_ip_var: ContextVar[str] = ContextVar("talaeats_request_ip", default="")
device_session_id_var: ContextVar[int | None] = ContextVar("talaeats_device_session_id", default=None)
