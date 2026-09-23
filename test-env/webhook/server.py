import http.server
import socketserver
import json

class WebhookHandler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length).decode('utf-8')
        
        try:
            # Try to pretty print if it's JSON
            data = json.loads(post_data)
            print("\n=== ALERT RECEIVED ===")
            print(json.dumps(data, indent=2))
            print("======================\n")
        except json.JSONDecodeError:
            print("\n=== RAW PAYLOAD ===")
            print(post_data)
            print("===================\n")
            
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

if __name__ == '__main__':
    PORT = 8080
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), WebhookHandler) as httpd:
        print(f"OOB Webhook Receiver running on port {PORT}")
        httpd.serve_forever()
