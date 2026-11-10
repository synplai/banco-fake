#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <SPI.h>
#include <MFRC522.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <esp_system.h>
#include <mbedtls/md.h>
#include <time.h>
#include "config.h"

constexpr byte SS_PIN = 5;
constexpr byte RESET_PIN = 22;
MFRC522 reader(SS_PIN, RESET_PIN);

#if MQTT_TLS
WiFiClientSecure transport;
#else
WiFiClient transport;
#endif
PubSubClient broker(transport);
String eventTopic, armTopic, operation;
time_t expires = 0;
uint32_t lastHello = 0;
uint32_t lastConnect = 0;
String lastCard;
uint32_t lastTap = 0;

String hex(const byte *bytes, size_t count, const char *alphabet) {
  String result;
  result.reserve(2 * count);
  for (size_t i = 0; i < count; i++) {
    result += alphabet[bytes[i] >> 4];
    result += alphabet[bytes[i] & 15];
  }
  return result;
}

String sign(const String &message) {
  byte digest[32];
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                  reinterpret_cast<const unsigned char *>(DEVICE_KEY), strlen(DEVICE_KEY),
                  reinterpret_cast<const unsigned char *>(message.c_str()), message.length(), digest);
  return hex(digest, sizeof(digest), "0123456789abcdef");
}

void publishEvent(const char *type, const String &op = "", const String &card = "") {
  byte random[16];
  esp_fill_random(random, sizeof(random));
  const String nonce = hex(random, sizeof(random), "0123456789abcdef");
  JsonDocument event;
  event["type"] = type;
  event["nonce"] = nonce;
  event["op"] = op;
  event["card"] = card;
  event["sig"] = sign(String(type) + "|" + DEVICE_ID + "|" + nonce + "|" + op + "|" + card);
  char output[384];
  const auto length = serializeJson(event, output, sizeof(output));
  broker.publish(eventTopic.c_str(), reinterpret_cast<const uint8_t *>(output), length, false);
}

void onMessage(char *topic, byte *payload, unsigned int length) {
  if (armTopic != topic) return;
  JsonDocument event;
  if (deserializeJson(event, payload, length)) return;
  const String next = event["op"] | "";
  const String limit = event["expires"] | "";
  const String proof = event["sig"] | "";
  if (next.length() != 36 || limit.length() != 10 ||
      proof != sign(String("arm|") + DEVICE_ID + "|" + next + "|" + limit)) return;
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
  SPI.begin(18, 19, 23, SS_PIN);
  reader.PCD_Init();
  reader.PCD_DumpVersionToSerial();
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  configTime(0, 0, "pool.ntp.org", "time.google.com");
#if MQTT_TLS
  transport.setCACert(MQTT_CA);
#endif
  broker.setServer(MQTT_HOST, MQTT_PORT);
  broker.setCallback(onMessage);
  broker.setBufferSize(768);
  broker.setSocketTimeout(3);
  eventTopic = String(MQTT_PREFIX) + "/" + DEVICE_ID + "/event";
  armTopic = String(MQTT_PREFIX) + "/" + DEVICE_ID + "/arm";
}

void loop() {
  if (WiFi.status() != WL_CONNECTED || time(nullptr) < 1700000000) { delay(80); return; }
  if (!broker.connected()) {
    if (millis() - lastConnect < 2500) { delay(25); return; }
    lastConnect = millis();
    const char *user = MQTT_USER[0] ? MQTT_USER : nullptr;
    const char *password = MQTT_USER[0] ? MQTT_PASSWORD : nullptr;
    if (!broker.connect(DEVICE_ID, user, password)) {
      Serial.printf("MQTT indisponivel (%d).\n", broker.state());
      return;
    }
    broker.subscribe(armTopic.c_str(), 1);
    publishEvent("hello");
    lastHello = millis();
    Serial.println("MQTT conectado.");
  }
  broker.loop();
  if (millis() - lastHello >= 8000) {
    publishEvent("hello");
    lastHello = millis();
  }
  if (operation.isEmpty() || time(nullptr) >= expires) { delay(15); return; }
  if (reader.PICC_IsNewCardPresent() && reader.PICC_ReadCardSerial()) {
    const String card = hex(reader.uid.uidByte, reader.uid.size, "0123456789ABCDEF");
    reader.PICC_HaltA();
    reader.PCD_StopCrypto1();
    if (card != lastCard || millis() - lastTap >= 1000) {
      publishEvent("tap", operation, card);
      lastCard = card;
      lastTap = millis();
      Serial.println("Cartao enviado. Consulte o resultado no site.");
    }
  }
  delay(15);
}
