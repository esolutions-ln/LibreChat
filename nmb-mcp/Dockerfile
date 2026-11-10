FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY nmbmcp ./nmbmcp
RUN useradd -r -u 10001 nmb
USER nmb
EXPOSE 8090
# Streamable HTTP on /mcp. NMB_MCP_TOKEN is required; see docs/nmb/MCP.md.
CMD ["python", "-m", "nmbmcp", "--http", "--host", "0.0.0.0", "--port", "8090"]
