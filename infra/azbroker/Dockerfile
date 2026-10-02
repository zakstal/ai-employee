# Azure token broker: official Azure CLI image + a stdlib HTTP server speaking the
# App Service managed-identity token protocol. Login state persists in /azure.
FROM mcr.microsoft.com/azure-cli:2.90.0-azurelinux3.0
COPY server.py /server.py
ENV AZURE_CONFIG_DIR=/azure
VOLUME /azure
EXPOSE 8081
CMD ["python3", "/server.py"]
