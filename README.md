# Banco Virtual

Simulador financeiro em português para atividades educacionais. Cada aluno entra com seu próprio usuário. Um estabelecimento pode ter um ou mais alunos autorizados. Cada um pode alternar entre a conta pessoal e a conta do CNPJ fictício. O gestor cadastra as contas e coloca saldo nas duas modalidades.

## Experimente no VS Code

Requisito: Node.js 24. Abra a pasta `banco-feira` no VS Code e execute no terminal:

```powershell
npm.cmd ci
npm.cmd run demo
```

Abra [localhost:3000](http://localhost:3000). A demonstração tem 12 alunos, quatro estabelecimentos e saldos de exemplo.

| Perfil | Usuário | Senha local |
| --- | --- | --- |
| Gestor | `gestor` | `FeiraDemo2026` |
| Aluno do primeiro estabelecimento | `aluno1` | `FeiraDemo2026` |
| Aluno de outro estabelecimento | `aluno4` | `FeiraDemo2026` |

Use dois navegadores, ou uma janela anônima, para testar comprador e vendedor ao mesmo tempo. A demonstração usa `data/demo.sqlite` e funciona sem broker, inclusive para vendas por Pix. Em macOS/Linux, use `npm` no lugar de `npm.cmd`.

## Configure o banco

1. Pare a demonstração com **Ctrl+C**.
2. Execute `Copy-Item .env.example .env` e edite o arquivo `.env`. Defina uma senha inicial de pelo menos 10 caracteres em `ADMIN_PASSWORD`.
3. Execute `npm.cmd start` ou `npm.cmd run dev`. O banco fica em `data/banco.sqlite`. O primeiro início cria a conta do gestor. Depois disso, o login fica armazenado no banco.
4. Cadastre os alunos em **Alunos**. Entregue os acessos individualmente. Em **Estabelecimentos**, cadastre cada CNPJ fictício e selecione um ou mais alunos autorizados.
5. Use **Liberar saldo** para creditar os alunos e os estabelecimentos. Cada crédito aparece no extrato.

Use **Editar** ao lado de um aluno para atualizar o nome, o usuário ou a senha. Ao trocar a senha, o aluno precisa entrar de novo. Na lista de **Estabelecimentos**, use **Editar** para alterar o nome, o CNPJ fictício e os alunos autorizados.

Use **Excluir** para retirar um cadastro de uso. O histórico de movimentações continua disponível, e o saldo da conta excluída fica indisponível. Se excluir o último aluno autorizado de um estabelecimento, use **Editar** no estabelecimento para autorizar outro. Para reutilizar a maquininha de um estabelecimento excluído, gere um **Novo código** em **Maquininhas**.

## Maquininhas ESP32 e RC522

O firmware em `firmware/` é para a placa ESP32 Dev Module e leitor MFRC522 (RC522) por SPI. Abra essa pasta em uma janela do VS Code com a extensão **PlatformIO IDE**.

| RC522 | ESP32 |
| --- | --- |
| 3.3V | 3V3 |
| GND | GND |
| SDA / SS | GPIO 5 |
| SCK | GPIO 18 |
| MOSI | GPIO 23 |
| MISO | GPIO 19 |
| RST | GPIO 22 |
| IRQ | Deixe desconectado |

Alimente o RC522 com 3,3 V. Use cartões ou chaveiros compatíveis com o leitor, por exemplo MIFARE Classic de 13,56 MHz. O Wi-Fi deve oferecer 2,4 GHz e permitir acesso ao broker e à sincronização NTP do ESP32.

1. No painel do gestor, abra **Maquininhas → Registrar maquininha**. Guarde o ID e a chave exibidos e entregue o código de vínculo ao aluno responsável pelo estabelecimento.
2. Copie `firmware/src/config.example.h` para `firmware/src/config.h`. Preencha Wi-Fi, `DEVICE_ID` e `DEVICE_KEY`. Use um par diferente por ESP32.
3. Grave pelo botão **Upload** do PlatformIO. O monitor serial a 115200 mostra a conexão e a leitura.
4. Um aluno autorizado entra em **Meu estabelecimento → Vincular maquininha** e informa o código. O gestor passa a ver o CNPJ e o status do terminal.
5. O aluno comprador abre **Minha conta → Vincular cartão**, escolhe um terminal vinculado e online e aproxima o cartão em até um minuto. O gestor acompanha quem tem cartão e pode desfazer o vínculo.
6. Para cobrar, o vendedor abre **Meu estabelecimento → Efetuar venda**, digita o valor e toca **Cobrar no cartão**. Após a aproximação, o vendedor vê o resultado e pode converter a cobrança em Pix se necessário.

O broker informado já consta nos exemplos: `tokaido.proxy.rlwy.net:17906`. A configuração fornecida usa MQTT em TCP. As mensagens são assinadas com HMAC por maquininha. Para criptografar o transporte, configure um listener TLS no broker, use `mqtts://` no servidor e habilite `MQTT_TLS` com a CA correspondente no firmware. Se o broker exigir credenciais, configure `MQTT_USER` e `MQTT_PASSWORD`. Use o mesmo `MQTT_PREFIX` no servidor e nos terminais. Em um broker compartilhado, use um prefixo exclusivo desta instalação e, se disponível, permissões por tópico.

## Pix simulado

Em **Minha conta**, **Meu estabelecimento** ou **Conta do gestor**, use **Enviar Pix** para transferir por nome de usuário ou pelo CNPJ fictício do estabelecimento. Revise a conta de origem, o destinatário e o valor antes de confirmar. O pagamento sai do saldo da conta aberta. Os alunos e estabelecimentos veem a operação no extrato, e o gestor acompanha pelo painel de movimentações.

Para cobrar uma venda, o vendedor pode tocar **Gerar Pix** no teclado ou converter uma cobrança em aberto. A tela mostra o QR Code e o código completo para copiar. O comprador abre **Pagar cobrança** na conta que deseja usar e escaneia o QR Code, carrega uma foto ou cola o código. O código é exclusivo do Banco Virtual.

No celular, o navegador exige HTTPS e permissão de câmera para leitura ao vivo. O localhost é suficiente para testes no próprio computador. [Requisitos de câmera no navegador](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

## Publicação no Railway

1. Envie o conteúdo da pasta `banco-feira` para um repositório e conecte esse repositório a um serviço no Railway. Se a pasta estiver dentro de um repositório maior, configure a raiz do serviço para apontar para ela.
2. Com um serviço PostgreSQL no mesmo projeto e ambiente, abra **Variables** no serviço do Banco Virtual e adicione uma referência à variável `DATABASE_URL` do serviço PostgreSQL. Por exemplo, se o serviço se chama `Postgres`, o valor é `${{Postgres.DATABASE_URL}}`. A aplicação cria as tabelas na primeira inicialização. [PostgreSQL no Railway](https://docs.railway.com/databases/postgresql)
3. Em **Variables**, defina `ADMIN_USER`, `ADMIN_PASSWORD` e `MQTT_URL=mqtt://tokaido.proxy.rlwy.net:17906` ou o endpoint TLS do broker. Se usar um prefixo diferente ou autenticação MQTT, defina as variáveis correspondentes.
4. Gere um domínio HTTPS em **Networking**. O Dockerfile instala as dependências, e a aplicação usa o `PORT` informado pelo Railway e responde em `/health`. [Verificação de saúde no Railway](https://docs.railway.com/deployments/healthchecks)

Com `DATABASE_URL`, os dados são salvos no PostgreSQL e o serviço web dispensa um volume próprio. O SQLite continua disponível para uso local ou no Railway com um volume montado em `/data` e `DATABASE_URL` ausente. Os dados de um arquivo SQLite existente precisam ser migrados separadamente para o PostgreSQL. [Volumes no Railway](https://docs.railway.com/volumes)

## Estrutura e testes

- `web/`: interface responsiva, teclado de venda e leitor de QR Code.
- `server/`: API Node.js, sessões, PostgreSQL ou SQLite, SSE e integração MQTT.
- `firmware/`: código do ESP32 e configuração do RC522.
- `test/`: fluxos com API real, banco em memória, broker local e maquininha simulada.

O site e a API rodam no mesmo domínio. O Pix é confirmado por HTTPS. O SSE avisa os navegadores quando o estado muda, com consultas periódicas como alternativa se a conexão cair. O MQTT só transporta eventos e comandos da maquininha. Os valores são armazenados em centavos, e a baixa da cobrança e a movimentação dos dois saldos ocorrem em uma única transação.

Execute `npm.cmd test` para verificar autorização, QR Code, pagamentos concorrentes, notificações SSE, vínculo RFID, recusa por saldo e troca de cartão por Pix.

Para repetir os testes com PostgreSQL, defina `TEST_DATABASE_URL` com a URL de um banco de testes. A suíte cria e remove um esquema isolado por cenário.
