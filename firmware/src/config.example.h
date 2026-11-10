#pragma once

constexpr char WIFI_SSID[] = "NOME_DA_REDE";
constexpr char WIFI_PASSWORD[] = "SENHA_DA_REDE";
constexpr char MQTT_HOST[] = "tokaido.proxy.rlwy.net";
constexpr uint16_t MQTT_PORT = 17906;
constexpr char MQTT_USER[] = "";
constexpr char MQTT_PASSWORD[] = "";
constexpr char MQTT_PREFIX[] = "bancofeira/v1";
constexpr char DEVICE_ID[] = "COLE_O_ID_DA_MAQUININHA";
constexpr char DEVICE_KEY[] = "COLE_A_CHAVE_DA_MAQUININHA";

// Para usar MQTT sobre TLS, defina como 1, ajuste a porta e informe a CA do broker.
#define MQTT_TLS 0
constexpr char MQTT_CA[] = "";
