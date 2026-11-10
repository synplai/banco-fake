#pragma once

// Sobrescritas opcionais para o broker. Wi-Fi, ID e chave ficam no ESP32.
constexpr char MQTT_HOST[] = "tokaido.proxy.rlwy.net";
constexpr uint16_t MQTT_PORT = 17906;
constexpr char MQTT_USER[] = "";
constexpr char MQTT_PASSWORD[] = "";
constexpr char MQTT_PREFIX[] = "bancofeira/v1";

// Para usar MQTT sobre TLS, defina como 1, ajuste a porta e informe a CA do broker.
#define MQTT_TLS 0
constexpr char MQTT_CA[] = "";
