# Finny-certified LEAN engine image.
#
# Build stage: check out the pinned QuantConnect LEAN commit and compile the
# launcher. Run stage: minimal, non-root, no debug tooling, no network tools.
# The image is built and signed by the Finny release pipeline; run containers
# never build or install anything.
#
# Usage (from the Finny release pipeline):
#   docker build -t ghcr.io/finny-ai/lean-engine:<commit> .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

ARG LEAN_COMMIT=c6cc3b743ed7b65d5e0b9fa2bfc18b7d3ac2aea0
WORKDIR /src
RUN git init -q lean && \
    cd lean && \
    git remote add origin https://github.com/QuantConnect/Lean.git && \
    git fetch -q --depth 1 origin "$LEAN_COMMIT" && \
    git checkout -q FETCH_HEAD && \
    dotnet build QuantConnect.Lean.sln -c Release --nologo -v minimal

FROM mcr.microsoft.com/dotnet/runtime:10.0 AS run

RUN useradd --uid 10001 --create-home finny
WORKDIR /Lean
COPY --from=build /src/lean/Launcher/bin/Release /Lean/Launcher
COPY --from=build /src/lean/Common /Lean/Common
COPY --from=build /src/lean/Algorithm.CSharp/bin/Release /Lean/Algorithm.CSharp
COPY --from=build /src/lean/Algorithm.Python /Lean/Algorithm.Python
COPY --from=build /src/lean/Data /Lean/Data
COPY --from=build /src/lean/LICENSE /Lean/LICENSE
COPY --from=build /src/lean/NOTICE /Lean/NOTICE

USER finny
ENTRYPOINT ["dotnet", "/Lean/Launcher/QuantConnect.Lean.Launcher.dll"]
