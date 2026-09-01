import os
import requests

token = os.environ.get('GITHUB_TOKEN') or os.popen('gh auth token').read().strip()
headers = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': f'Bearer {token}'
}

url = 'https://api.github.com/repos/Yasirdora/darkroom/deployments'
resp = requests.get(url, headers=headers)
deployments = resp.json()

for dep in deployments:
    dep_id = dep['id']
    # 1. Set to inactive
    status_url = f"{url}/{dep_id}/statuses"
    requests.post(status_url, headers=headers, json={"state": "inactive"})
    
    # 2. Delete deployment
    del_url = f"{url}/{dep_id}"
    del_resp = requests.delete(del_url, headers=headers)
    print(f"Deleted deployment {dep_id}: {del_resp.status_code}")
