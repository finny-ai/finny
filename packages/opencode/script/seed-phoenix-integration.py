from __future__ import annotations

import argparse
from datetime import datetime, timezone

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default="http://127.0.0.1:6006")
    parser.add_argument("--project", required=True)
    parser.add_argument("--session", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    provider = TracerProvider(
        resource=Resource.create(
            {
                "service.name": "finny-phoenix-integration",
                "openinference.project.name": args.project,
                "finny.run_id": args.run_id,
            }
        )
    )
    exporter = OTLPSpanExporter(endpoint=f"{args.endpoint.rstrip('/')}/v1/traces")
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    tracer = trace.get_tracer("finny.integration")

    shared = {
        "session.id": args.session,
        "finny.session_id": args.session,
        "finny.main_session_id": args.session,
        "finny.run_id": args.run_id,
        "openinference.project.name": args.project,
        "git.commit": "ci-fixture",
    }
    with tracer.start_as_current_span("finny.agent.run", attributes=shared):
        pass
    with tracer.start_as_current_span("finny.tool.execute", attributes=shared):
        pass
    with tracer.start_as_current_span("finny.run.completed", attributes=shared):
        pass
    provider.force_flush(timeout_millis=10_000)
    provider.shutdown()
    print(datetime.now(timezone.utc).isoformat())


if __name__ == "__main__":
    main()
