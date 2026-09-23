FROM python:3.11-slim
WORKDIR /app
COPY server.py .
EXPOSE 8080
# Force unbuffered output so print statements hit docker logs immediately
ENV PYTHONUNBUFFERED=1
CMD ["python", "server.py"]
