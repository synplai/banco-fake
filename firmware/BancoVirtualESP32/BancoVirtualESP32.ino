#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <AsyncUDP.h>
#include <Preferences.h>
#include <esp_http_server.h>
#include <esp_idf_version.h>
#include <esp_arduino_version.h>
#include <lwip/sockets.h>
#include <atomic>
#include <SPI.h>
#include <MFRC522.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <time.h>

// O Wi-Fi e a identidade da maquininha são configurados no navegador.
// Altere apenas o MQTT se o servidor usar outro broker ou prefixo.
#if defined(PLATFORMIO) && __has_include("../src/config.h")
#include "../src/config.h"
#else
constexpr char MQTT_HOST[] = "tokaido.proxy.rlwy.net";
constexpr uint16_t MQTT_PORT = 17906;
constexpr char MQTT_USER[] = "";
constexpr char MQTT_PASSWORD[] = "";
constexpr char MQTT_PREFIX[] = "bancofeira/v1";

// Para usar MQTT sobre TLS, defina como 1, ajuste a porta e informe a CA do broker.
#define MQTT_TLS 0
constexpr char MQTT_CA[] = "";
#endif

constexpr byte SS_PIN = 21;
constexpr byte RESET_PIN = 22;
constexpr byte SCK_PIN = 18;
constexpr byte MISO_PIN = 19;
constexpr byte MOSI_PIN = 23;
constexpr byte LED_PIN = 12;
constexpr char SETUP_WIFI_PASSWORD[] = "12345678";
constexpr char SETUP_PAGE_PATH[] = "/";
constexpr char SETUP_URL[] = "http://192.168.4.1/";
const IPAddress SETUP_IP(192, 168, 4, 1);
MFRC522 reader(SS_PIN, RESET_PIN);

#if MQTT_TLS
WiFiClientSecure transport;
#else
WiFiClient transport;
#endif
PubSubClient broker(transport);
httpd_handle_t portalServer = nullptr;
AsyncUDP portalDns;
struct DeviceSettings {
  char ssid[33];
  char password[65];
  char id[37];
  char key[65];
};
bool saveSettings(const DeviceSettings &updated);
void generateIdentity(DeviceSettings &updated);
DeviceSettings settings{};
char activeDeviceId[37]{};
char activeDeviceKey[65]{};
String eventTopic, armTopic, operation, mqttClientId;
time_t expires = 0;
uint32_t lastHello = 0;
uint32_t lastConnect = 0;
String lastCard;
uint32_t lastTap = 0;
uint32_t ledStarted = 0;
uint32_t lastNetworkNotice = 0;
bool ledOn = false;
bool settingsReady = false;
bool portalActive = false;
std::atomic<bool> restartPending{false};
std::atomic<uint32_t> restartStarted{0};
uint32_t lastPortalAttempt = 0;
uint32_t lastWifiAttempt = 0;
uint8_t portalClients = 0;
String portalToken, portalSsid, portalIp;

String hex(const byte *bytes, size_t count, const char *alphabet) {
  String result;
  result.reserve(2 * count);
  for (size_t i = 0; i < count; i++) {
    result += alphabet[bytes[i] >> 4];
    result += alphabet[bytes[i] & 15];
  }
  return result;
}

String randomHex(size_t bytes) {
  byte buffer[32];
  esp_fill_random(buffer, bytes);
  return hex(buffer, bytes, "0123456789abcdef");
}

bool allHex(const String &value) {
  for (size_t i = 0; i < value.length(); i++) {
    if (!isxdigit(static_cast<unsigned char>(value[i]))) return false;
  }
  return true;
}

bool validId(const String &id) {
  if (id.length() == 4) {
    for (size_t i = 0; i < 4; i++) {
      if (id[i] < '0' || id[i] > '9') return false;
    }
    return true;
  }
  if (id.length() != 36 || id[8] != '-' || id[13] != '-' || id[18] != '-' || id[23] != '-') return false;
  String digits = id;
  digits.replace("-", "");
  return digits.length() == 32 && allHex(digits);
}

bool hasIdentity() {
  return validId(settings.id) && strlen(settings.key) == 64 && allHex(settings.key);
}

void loadSettings() {
  Preferences preferences;
  if (!preferences.begin("bancovirtual", true)) return;
  DeviceSettings saved{};
  const bool loaded = preferences.getBytesLength("settings-v1") == sizeof(saved) &&
                      preferences.getBytes("settings-v1", &saved, sizeof(saved)) == sizeof(saved);
  preferences.end();
  if (loaded && memchr(saved.ssid, 0, sizeof(saved.ssid)) && memchr(saved.password, 0, sizeof(saved.password)) &&
      memchr(saved.id, 0, sizeof(saved.id)) && memchr(saved.key, 0, sizeof(saved.key))) settings = saved;
}

bool saveSettings(const DeviceSettings &updated) {
  Preferences preferences;
  if (!preferences.begin("bancovirtual", false)) return false;
  const bool saved = preferences.putBytes("settings-v1", &updated, sizeof(updated)) == sizeof(updated);
  preferences.end();
  if (saved) settings = updated;
  return saved;
}

String escapeHtml(String value) {
  value.replace("&", "&amp;");
  value.replace("<", "&lt;");
  value.replace(">", "&gt;");
  value.replace("\"", "&quot;");
  value.replace("'", "&#39;");
  return value;
}

String requestHeader(httpd_req_t *request, const char *name) {
  char value[768];
  if (httpd_req_get_hdr_value_str(request, name, value, sizeof(value)) != ESP_OK) return "";
  return String(value);
}

esp_err_t sendPortalResponse(httpd_req_t *request, int status, const char *type, const String &body) {
  const char *responseStatus = "200 OK";
  switch (status) {
    case 302: responseStatus = "302 Found"; break;
    case 400: responseStatus = "400 Bad Request"; break;
    case 403: responseStatus = "403 Forbidden"; break;
    case 404: responseStatus = "404 Not Found"; break;
    case 409: responseStatus = "409 Conflict"; break;
    case 500: responseStatus = "500 Internal Server Error"; break;
  }
  httpd_resp_set_status(request, responseStatus);
  httpd_resp_set_type(request, type);
  httpd_resp_set_hdr(request, "Cache-Control", "no-store");
  return httpd_resp_send(request, body.c_str(), body.length());
}

bool readForm(httpd_req_t *request, char (&body)[513]) {
  if (!request->content_len || request->content_len >= sizeof(body)) return false;
  size_t received = 0;
  while (received < request->content_len) {
    const int count = httpd_req_recv(request, body + received, request->content_len - received);
    if (count <= 0) return false;
    received += count;
  }
  body[received] = '\0';
  return true;
}

bool hasField(const char *body, const char *key) {
  char value[513];
  return httpd_query_key_value(body, key, value, sizeof(value)) == ESP_OK;
}

String formField(const char *body, const char *key) {
  char value[513];
  if (httpd_query_key_value(body, key, value, sizeof(value)) != ESP_OK) return "";
  String decoded;
  decoded.reserve(strlen(value));
  for (size_t i = 0; value[i]; i++) {
    if (value[i] == '+') decoded += ' ';
    else if (value[i] == '%') {
      if (!isxdigit(static_cast<unsigned char>(value[i + 1])) ||
          !isxdigit(static_cast<unsigned char>(value[i + 2]))) return "";
      const char digits[] = {value[i + 1], value[i + 2], '\0'};
      const char character = static_cast<char>(strtoul(digits, nullptr, 16));
      if (!character) return "";
      decoded += character;
      i += 2;
    } else decoded += value[i];
  }
  return decoded;
}

esp_err_t portalPage(httpd_req_t *request, int status, const String &message) {
  String page;
  page.reserve(5200);
  page += R"HTML(<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maquininha Banco Virtual</title><style>
body{font:16px system-ui,sans-serif;background:#f5f1fc;color:#251743;margin:0;padding:20px}
main{max-width:540px;margin:auto}section{background:white;border:1px solid #e2d8ee;border-radius:16px;padding:16px;margin:12px 0}
h1,h2,p{margin:0 0 10px}h2{font-size:19px}label{display:block;margin:10px 0;font-weight:600}
input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:10px;border:1px solid #bdb0d0;border-radius:8px;font:inherit}
button{background:#6439d0;color:#fff;font:600 15px system-ui;border:0;border-radius:8px;padding:10px 14px}
summary{cursor:pointer}small{display:block;color:#534765}.notice{padding:10px;background:#e9e0ff;border-radius:8px}
</style><main><h1>Maquininha Banco Virtual</h1><p>Configuração local do ESP32</p>)HTML";
  if (message.length()) page += String("<p class='notice'>") + escapeHtml(message) + "</p>";
  const String token = String("<input type='hidden' name='token' value='") + portalToken + "'>";
  page += "<section><h2>Wi-Fi de operação</h2><form method='post' action='/wifi'>" + token +
    "<label>Nome da rede (SSID)<input name='ssid' maxlength='32' required value='" + escapeHtml(settings.ssid) +
    "'></label><label>Senha do Wi-Fi<input name='password' type='password' maxlength='64' autocomplete='new-password'></label>" +
    "<small>Se a rede for a mesma, o campo vazio mantém a senha atual.</small>" +
    "<label><input type='checkbox' name='open'> Rede sem senha</label><button>Salvar e conectar</button></form></section>";
  page += "<section><details><summary>Cadastro da maquininha</summary>";
  if (hasIdentity()) {
    page += String("<label>ID de cadastro<input readonly value='") + settings.id +
      "'></label><label>Chave da maquininha<input readonly value='" + settings.key +
      "'></label><small>Copie o ID e a chave para o painel do gestor. Mantenha a chave em segredo.</small>";
    page += "<details><summary>Trocar a identidade</summary><p>Use se o ID ainda não foi cadastrado ou está em uso por outro aparelho.</p>";
  } else {
    page += "<p>O ID e a chave serão gerados ao salvar o Wi-Fi, ou você pode gerar agora.</p>";
  }
  page += "<form method='post' action='/identity'>" + token;
  if (hasIdentity()) {
    page += "<label><input type='checkbox' name='replace' required> Confirmo a troca do ID e da chave.</label>";
  }
  page += "<button>Gerar ID e chave</button></form>";
  if (hasIdentity()) page += "</details>";
  else {
    page += "<details><summary>Usar credenciais já cadastradas</summary><form method='post' action='/identity'>" + token +
      "<label>ID<input name='id' maxlength='36' required></label><label>Chave<input name='key' type='password' minlength='64' maxlength='64' required></label>" +
      "<button>Salvar identidade</button></form></details>";
  }
  page += "</details></section>";
  page += "</main></html>";
  httpd_resp_set_hdr(request, "X-Frame-Options", "DENY");
  httpd_resp_set_hdr(request, "Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  return sendPortalResponse(request, status, "text/html; charset=utf-8", page);
}

bool reachedSetupNetwork(httpd_req_t *request) {
  sockaddr_storage local{};
  socklen_t length = sizeof(local);
  const int socket = httpd_req_to_sockfd(request);
  if (socket < 0 || getsockname(socket, reinterpret_cast<sockaddr *>(&local), &length) != 0) return false;
  const uint8_t expected[] = {192, 168, 4, 1};
  if (local.ss_family == AF_INET) {
    const auto *address = reinterpret_cast<const sockaddr_in *>(&local);
    return memcmp(&address->sin_addr, expected, sizeof(expected)) == 0;
  }
#if LWIP_IPV6
  if (local.ss_family == AF_INET6) {
    const auto *address = reinterpret_cast<const sockaddr_in6 *>(&local);
    const uint8_t mappedPrefix[] = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff};
    return memcmp(address->sin6_addr.s6_addr, mappedPrefix, sizeof(mappedPrefix)) == 0 &&
      memcmp(address->sin6_addr.s6_addr + sizeof(mappedPrefix), expected, sizeof(expected)) == 0;
  }
#endif
  return false;
}

bool isPortalRequest(httpd_req_t *request) {
  const String host = requestHeader(request, "Host");
  return (host == portalIp || host == portalIp + ":80") && reachedSetupNetwork(request);
}

esp_err_t redirectToPortal(httpd_req_t *request) {
  if (!reachedSetupNetwork(request)) {
    return sendPortalResponse(request, 403, "text/plain; charset=utf-8", "Conecte ao Wi-Fi BancoVirtual.");
  }
  if (request->method != HTTP_GET) {
    return sendPortalResponse(request, 404, "text/plain; charset=utf-8", "Página não encontrada.");
  }
  httpd_resp_set_hdr(request, "Location", SETUP_URL);
  return sendPortalResponse(request, 302, "text/plain; charset=utf-8", "Abra a configuração da maquininha.");
}

esp_err_t portalNotFound(httpd_req_t *request, httpd_err_code_t) {
  return redirectToPortal(request);
}

esp_err_t showPortalPage(httpd_req_t *request) {
  if (isPortalRequest(request)) {
    Serial.println("Portal: pagina de configuracao solicitada.");
    return portalPage(request, 200, "");
  }
  return redirectToPortal(request);
}

bool validPortalPost(httpd_req_t *request, char (&body)[513]) {
  return isPortalRequest(request) && !restartPending &&
    readForm(request, body) && formField(body, "token") == portalToken;
}

void generateIdentity(DeviceSettings &updated) {
  String id;
  do { id = String(1000 + esp_random() % 9000); } while (id == settings.id);
  id.toCharArray(updated.id, sizeof(updated.id));
  randomHex(32).toCharArray(updated.key, sizeof(updated.key));
}

esp_err_t forbiddenPortalRequest(httpd_req_t *request) {
  return sendPortalResponse(request, 403, "text/plain; charset=utf-8", "Abra novamente http://192.168.4.1/.");
}

esp_err_t saveIdentity(httpd_req_t *request) {
  char body[513];
  if (!validPortalPost(request, body)) return forbiddenPortalRequest(request);
  if (hasIdentity() && !hasField(body, "replace")) {
    return portalPage(request, 409, "Confirme a troca antes de gerar outro ID.");
  }
  DeviceSettings updated = settings;
  String id = formField(body, "id");
  String key = formField(body, "key");
  id.trim(); id.toLowerCase();
  key.trim(); key.toLowerCase();
  if (hasField(body, "id") || hasField(body, "key")) {
    if (!validId(id) || key.length() != 64 || !allHex(key)) {
      return portalPage(request, 400, "Informe o ID e a chave de 64 caracteres cadastrados no banco.");
    }
    id.toCharArray(updated.id, sizeof(updated.id));
    key.toCharArray(updated.key, sizeof(updated.key));
  } else {
    generateIdentity(updated);
  }
  const bool saved = saveSettings(updated);
  return portalPage(request, saved ? 200 : 500, saved ? "Identidade salva. Copie os dados antes de conectar ao Wi-Fi." : "Não foi possível salvar a identidade.");
}

esp_err_t saveWifi(httpd_req_t *request) {
  char body[513];
  if (!validPortalPost(request, body)) return forbiddenPortalRequest(request);
  const String ssid = formField(body, "ssid");
  String password = formField(body, "password");
  if (!ssid.length() || ssid.length() > 32 || strlen(ssid.c_str()) != ssid.length()) {
    return portalPage(request, 400, "Informe um SSID de 1 a 32 bytes.");
  }
  if (hasField(body, "open")) password = "";
  else {
    if (password.isEmpty() && ssid == settings.ssid) password = settings.password;
    const bool valid = (password.isEmpty() && ssid == settings.ssid && !settings.password[0]) ||
      (password.length() >= 8 && password.length() <= 63) || (password.length() == 64 && allHex(password));
    if (!valid || strlen(password.c_str()) != password.length()) {
      return portalPage(request, 400, "Informe a senha do Wi-Fi ou marque Rede sem senha.");
    }
  }
  DeviceSettings updated = settings;
  ssid.toCharArray(updated.ssid, sizeof(updated.ssid));
  password.toCharArray(updated.password, sizeof(updated.password));
  if (!hasIdentity()) generateIdentity(updated);
  if (!saveSettings(updated)) {
    return portalPage(request, 500, "Não foi possível gravar o Wi-Fi.");
  }
  const esp_err_t sent = portalPage(request, 200, "Wi-Fi salvo. A maquininha vai reiniciar e conectar à rede escolhida.");
  restartStarted = millis();
  restartPending = true;
  return sent;
}

void printPortalAccess() {
  Serial.println("\n--- CONFIGURACAO DA MAQUININHA ---");
  Serial.print("Rede Wi-Fi: "); Serial.println(portalSsid);
  Serial.print("Senha da rede: "); Serial.println(SETUP_WIFI_PASSWORD);
  Serial.print("Abra http://"); Serial.print(portalIp); Serial.println(SETUP_PAGE_PATH);
}

size_t buildPortalDnsReply(const uint8_t *query, size_t length, uint8_t *reply, size_t capacity) {
  constexpr size_t headerLength = 12;
  if (length < headerLength + 5 || length > 512 || (query[2] & 0xf8) ||
      query[4] != 0 || query[5] != 1) return 0;
  size_t end = headerLength;
  while (end < length && query[end]) {
    const uint8_t labelLength = query[end];
    if (labelLength > 63 || labelLength > length - end - 1 || end - headerLength > 254) return 0;
    end += 1 + labelLength;
  }
  if (end >= length || end - headerLength > 254 || length - end < 5) return 0;
  end++;
  const bool answerA = query[end] == 0 && query[end + 1] == 1 && query[end + 2] == 0 && query[end + 3] == 1;
  end += 4;
  const uint8_t answer[] = {0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 192, 168, 4, 1};
  const size_t replyLength = end + (answerA ? sizeof(answer) : 0);
  if (replyLength > capacity) return 0;
  memcpy(reply, query, end);
  reply[2] = 0x84 | (query[2] & 1);
  reply[3] = 0;
  memset(reply + 6, 0, 6);
  if (answerA) {
    reply[7] = 1;
    memcpy(reply + end, answer, sizeof(answer));
  }
  return replyLength;
}

void handlePortalDns(AsyncUDPPacket &packet) {
  const IPAddress remote = packet.remoteIP();
  if (remote[0] != 192 || remote[1] != 168 || remote[2] != 4) return;
  uint8_t reply[528];
  const size_t length = buildPortalDnsReply(packet.data(), packet.length(), reply, sizeof(reply));
  if (length) packet.write(reply, length);
}

void startPortal() {
  if (portalActive) {
    printPortalAccess();
    return;
  }
  lastPortalAttempt = millis();
  portalSsid = String("BancoVirtual-") + String(static_cast<uint32_t>(ESP.getEfuseMac()) & 0xFFFFFF, HEX) + "-Setup";
  const IPAddress mask(255, 255, 255, 0), leaseStart(192, 168, 4, 2);
  if (!WiFi.mode(WIFI_AP_STA)) {
    Serial.println("Falha ao iniciar o modo de configuracao do Wi-Fi.");
    return;
  }
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  const bool networkConfigured = WiFi.softAPConfig(SETUP_IP, SETUP_IP, mask, leaseStart, SETUP_IP);
#else
  const bool networkConfigured = WiFi.softAPConfig(SETUP_IP, SETUP_IP, mask, leaseStart);
#endif
  if (!networkConfigured || !WiFi.softAP(portalSsid.c_str(), SETUP_WIFI_PASSWORD, 1, false, 1)) {
    Serial.println("Falha no Wi-Fi: a rede BancoVirtual nao foi criada.");
    WiFi.softAPdisconnect(true);
    return;
  }
  IPAddress ip = WiFi.softAPIP();
  for (int attempt = 0; attempt < 40 && !(ip == SETUP_IP); attempt++) {
    delay(25);
    ip = WiFi.softAPIP();
  }
  if (!(ip == SETUP_IP)) {
    Serial.println("O Wi-Fi nao assumiu o endereco 192.168.4.1.");
    WiFi.softAPdisconnect(true);
    return;
  }
  portalIp = ip.toString();
  portalToken = randomHex(16);
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.stack_size = 8192;
  config.max_open_sockets = 4;
  config.lru_purge_enable = true;
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
  config.max_req_hdr_len = 2048;
#endif
  config.recv_wait_timeout = 3;
  config.send_wait_timeout = 3;
  if (httpd_start(&portalServer, &config) != ESP_OK) {
    Serial.println("Falha ao iniciar o servidor HTTP.");
    WiFi.softAPdisconnect(true);
    return;
  }
  const httpd_uri_t routes[] = {
    {.uri = SETUP_PAGE_PATH, .method = HTTP_GET, .handler = showPortalPage, .user_ctx = nullptr},
    {.uri = "/configurar", .method = HTTP_GET, .handler = showPortalPage, .user_ctx = nullptr},
    {.uri = "/identity", .method = HTTP_POST, .handler = saveIdentity, .user_ctx = nullptr},
    {.uri = "/wifi", .method = HTTP_POST, .handler = saveWifi, .user_ctx = nullptr}
  };
  for (const auto &route : routes) {
    if (httpd_register_uri_handler(portalServer, &route) != ESP_OK) {
      httpd_stop(portalServer);
      portalServer = nullptr;
      Serial.println("Falha ao registrar a pagina de configuracao.");
      WiFi.softAPdisconnect(true);
      return;
    }
  }
  if (httpd_register_err_handler(portalServer, HTTPD_404_NOT_FOUND, portalNotFound) != ESP_OK) {
    Serial.println("Nao foi possivel ativar o redirecionamento de configuracao.");
  }
  portalDns.onPacket(handlePortalDns);
  if (!portalDns.listen(SETUP_IP, 53)) {
    Serial.println("Deteccao automatica indisponivel. Abra http://192.168.4.1/.");
  }
  portalActive = true;
  Serial.println("Portal HTTP iniciado.");
  printPortalAccess();
}

String sign(const String &message) {
  byte digest[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                  reinterpret_cast<const unsigned char *>(activeDeviceKey), strlen(activeDeviceKey),
                  reinterpret_cast<const unsigned char *>(message.c_str()), message.length(), digest);
  return hex(digest, sizeof(digest), "0123456789abcdef");
}

bool publishEvent(const char *type, const String &op, const String &card) {
  byte random[16];
  esp_fill_random(random, sizeof(random));
  const String nonce = hex(random, sizeof(random), "0123456789abcdef");
  JsonDocument event;
  event["type"] = type;
  event["nonce"] = nonce;
  event["op"] = op;
  event["card"] = card;
  event["sig"] = sign(String(type) + "|" + activeDeviceId + "|" + nonce + "|" + op + "|" + card);
  char output[384];
  const auto length = serializeJson(event, output, sizeof(output));
  return broker.publish(eventTopic.c_str(), reinterpret_cast<const uint8_t *>(output), length, false);
}

void onMessage(char *topic, byte *payload, unsigned int length) {
  if (armTopic != topic) return;
  JsonDocument event;
  if (deserializeJson(event, payload, length)) return;
  const String next = event["op"] | "";
  const String limit = event["expires"] | "";
  const String proof = event["sig"] | "";
  if (next.length() != 36 || limit.length() != 10 ||
      proof != sign(String("arm|") + activeDeviceId + "|" + next + "|" + limit)) return;
  const time_t now = time(nullptr);
  const time_t end = strtoll(limit.c_str(), nullptr, 10);
  if (now < 1700000000 || end <= now || end - now > 310) return;
  if (operation != next) {
    lastCard = "";
    Serial.println("Pronta para ler o cartao.");
  }
  operation = next;
  expires = end;
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);
  SPI.begin(SCK_PIN, MISO_PIN, MOSI_PIN, SS_PIN);
  reader.PCD_Init();
  delay(100);
  Serial.println("\nMaquininha Banco Virtual");
  reader.PCD_DumpVersionToSerial();
  loadSettings();
  WiFi.persistent(false);
  const DeviceSettings savedAtBoot = settings;
  settingsReady = savedAtBoot.ssid[0] && hasIdentity();
  memcpy(activeDeviceId, savedAtBoot.id, sizeof(activeDeviceId));
  memcpy(activeDeviceKey, savedAtBoot.key, sizeof(activeDeviceKey));
  startPortal();
  if (!settingsReady) return;
  Serial.println("Conectando ao Wi-Fi e sincronizando o relogio...");
  WiFi.setAutoReconnect(false);
  lastWifiAttempt = millis();
  WiFi.begin(savedAtBoot.ssid, savedAtBoot.password);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
#if MQTT_TLS
  transport.setCACert(MQTT_CA);
#endif
  broker.setServer(MQTT_HOST, MQTT_PORT);
  broker.setCallback(onMessage);
  broker.setBufferSize(768);
  broker.setSocketTimeout(3);
  eventTopic = String(MQTT_PREFIX) + "/" + activeDeviceId + "/event";
  armTopic = String(MQTT_PREFIX) + "/" + activeDeviceId + "/arm";
  mqttClientId = String("bv-") + sign(String("mqtt-client|") + activeDeviceId).substring(0, 20);
}

void loop() {
  const uint32_t now = millis();
  if (restartPending && now - restartStarted >= 1500) ESP.restart();
  if (!portalActive && now - lastPortalAttempt >= 5000) startPortal();
  if (portalActive) {
    const uint8_t clients = WiFi.softAPgetStationNum();
    if (clients != portalClients) {
      portalClients = clients;
      Serial.print("Clientes no Wi-Fi da maquininha: "); Serial.println(portalClients);
      if (clients && settingsReady && WiFi.status() != WL_CONNECTED) WiFi.disconnect(false, false);
    }
  }
  const bool wifiConnected = WiFi.status() == WL_CONNECTED;
  if (ledOn && now - ledStarted >= 500) ledOn = false;
  const bool portalLedOn = portalActive && (!wifiConnected || portalClients > 0) && (now / 500) % 2 == 0;
  digitalWrite(LED_PIN, ledOn || portalLedOn ? HIGH : LOW);
  if (!settingsReady || restartPending) { delay(25); return; }
  if (!wifiConnected && !portalClients && now - lastWifiAttempt >= 15000) {
    lastWifiAttempt = now;
    WiFi.reconnect();
  }
  if (!wifiConnected || time(nullptr) < 1700000000) {
    if (now - lastNetworkNotice >= 8000) {
      lastNetworkNotice = now;
      Serial.println(wifiConnected ? "Aguardando sincronizacao NTP." : "Aguardando Wi-Fi.");
    }
    delay(80);
    return;
  }
  if (!broker.connected()) {
    if (millis() - lastConnect < 2500) { delay(25); return; }
    lastConnect = millis();
    const char *user = MQTT_USER[0] ? MQTT_USER : nullptr;
    const char *password = MQTT_USER[0] ? MQTT_PASSWORD : nullptr;
    if (!broker.connect(mqttClientId.c_str(), user, password)) {
      Serial.printf("MQTT indisponivel (%d).\n", broker.state());
      return;
    }
    if (!broker.subscribe(armTopic.c_str(), 1)) {
      Serial.println("Nao foi possivel assinar o topico da maquininha.");
      broker.disconnect();
      return;
    }
    publishEvent("hello", "", "");
    lastHello = millis();
    Serial.println("MQTT conectado. Inicie o vinculo ou a cobranca no site.");
  }
  broker.loop();
  if (millis() - lastHello >= 8000) {
    publishEvent("hello", "", "");
    lastHello = millis();
  }
  if (operation.isEmpty() || time(nullptr) >= expires) { delay(15); return; }
  if (reader.PICC_IsNewCardPresent() && reader.PICC_ReadCardSerial()) {
    const String card = hex(reader.uid.uidByte, reader.uid.size, "0123456789ABCDEF");
    reader.PICC_HaltA();
    reader.PCD_StopCrypto1();
    if (card != lastCard || millis() - lastTap >= 2000) {
      if (publishEvent("tap", operation, card)) {
        lastCard = card;
        lastTap = millis();
        digitalWrite(LED_PIN, HIGH);
        ledStarted = lastTap;
        ledOn = true;
        Serial.println("Cartao enviado. Consulte o resultado no site.");
      } else {
        Serial.println("Falha ao enviar o cartao. Retire e aproxime novamente.");
      }
    }
  }
  delay(15);
}
