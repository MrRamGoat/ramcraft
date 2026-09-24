FROM python:3.12-slim

WORKDIR /app

# tar/gzip/du drive the backup and disk-usage paths in servers.py
RUN apt-get update \
 && apt-get install -y --no-install-recommends tar gzip coreutils \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
