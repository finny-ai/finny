# Finny overlay over the official LEAN engine build.
#
# Adds the Finny runtime user and owned dirs so run containers can execute
# non-root against the pinned engine. The base image is the QuantConnect
# daily build closest to the pinned LEAN commit; the production image is built
# from pinned source via Dockerfile.
FROM quantconnect/lean:17992

USER root
RUN useradd --uid 10001 --create-home finny \
    && mkdir -p /Results /Lean/Storage /Lean/Algorithm \
    && chown -R finny:finny /Results /Lean/Storage /Lean/Algorithm \
    && cp -a /root/.dotnet /opt/dotnet \
    && chmod -R a+rX /opt/dotnet \
    && ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet
ENV PATH="/opt/dotnet:/opt/miniconda3/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    DOTNET_ROOT="/opt/dotnet" \
    DOTNET_CLI_TELEMETRY_OPTOUT="1" \
    DOTNET_NOLOGO="1" \
    PYTHONDONTWRITEBYTECODE="1"
USER finny
