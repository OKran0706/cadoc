FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (for PyNaCl and potential C extensions)
RUN apt-get update && apt-get install -y \
    build-essential \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Expose port (FastAPI defaults to 8000, we'll use 8443 for mTLS feel)
EXPOSE 8443

# Start uvicorn on plain HTTP (mTLS is terminated by the LB)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8443"]
