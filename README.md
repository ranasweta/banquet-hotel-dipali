Docker/image build command
```
podman build -t hdwed .
```


Auth artifact reg
```
gcloud auth print-access-token | podman login -u oauth2accesstoken --password-stdin asia-southeast1-docker.pkg.dev
```

Tag to artifact reg
```
podman tag hdwed asia-southeast1-docker.pkg.dev/hdofficial/hdwed/hdwed:v1
```

Push to artifact reg
```
podman push asia-southeast1-docker.pkg.dev/hdofficial/hdwed/hdwed:v1
```

TO pick up shell vars (linux/mac only)
```
source .env
```

Deploy command using shell vars
```
gcloud run deploy hdwed \
  --image=asia-southeast1-docker.pkg.dev/hdofficial/hdwed/hdwed:v1 \
  --region=asia-southeast1 \
  --port=3000 \
  --cpu=1 --memory=1Gi \
  --min-instances=1 --max-instances=1 \
  --allow-unauthenticated \
  --set-env-vars="^##^DATABASE_URL=${DATABASE_URL}##SESSION_SECRET=${SESSION_SECRET}##STORAGE_KEY=${STORAGE_KEY}##CRON_SECRET=${CRON_SECRET}##DB_POOL_MAX=10"
```