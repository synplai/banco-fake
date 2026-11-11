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

Use **Excluir** para retirar um cadastro de uso. O histórico de movimentações continua disponível, e o saldo da conta excluída fica indisponível. Se excluir o último aluno autorizado de um estabelecimento, use **Editar** no estabelecimento para autorizar outro. A maquininha de um estabelecimento excluído volta à lista de disponíveis.

## Maquininhas ESP32 e RC522

O firmware é para a placa ESP32 Dev Module e leitor MFRC522 (RC522) por SPI. No **Arduino IDE**, abra `firmware/BancoVirtualESP32/BancoVirtualESP32.ino`. Para usar o **PlatformIO IDE** no VS Code, abra a pasta `firmware/`.

| RC522 | ESP32 |
| --- | --- |
| 3.3V | 3V3 |
| GND | GND |
| SDA / SS | GPIO 21 |
| SCK | GPIO 18 |
| MOSI | GPIO 23 |
| MISO | GPIO 19 |
| RST | GPIO 22 |
| IRQ | Deixe desconectado |

Alimente o RC522 com 3,3 V. O LED verde usa o GPIO 12 e pisca quando a leitura é enviada ao broker. O resultado do vínculo ou pagamento aparece no site. Use cartões ou chaveiros compatíveis com o leitor, por exemplo MIFARE Classic de 13,56 MHz. O Wi-Fi deve oferecer 2,4 GHz e permitir acesso ao broker e à sincronização NTP do ESP32.

1. No **Arduino IDE**, instale **MFRC522**, **PubSubClient** e **ArduinoJson 7**, selecione a placa e a porta USB e grave o sketch. O Wi-Fi e a identidade são configurados no navegador. No **PlatformIO**, o arquivo `firmware/src/config.h` é opcional para mudar o broker.
2. Ligue a maquininha e conecte o celular à rede **BancoVirtual-…-Setup** com a senha **12345678**. Essa rede fica disponível enquanto a maquininha estiver ligada.
3. Toque em **Fazer login na rede** se o celular oferecer essa opção. Se ela não aparecer, permaneça conectado ao Wi-Fi da maquininha e abra **http://192.168.4.1/**. Informe o SSID e a senha da rede de operação e toque em **Salvar e conectar**. O ESP32 reinicia e usa os dados gravados. Para trocar a senha depois, repita o mesmo procedimento.
4. No primeiro salvamento, o ESP32 gera um ID de quatro dígitos. Consulte-o em **Cadastro da maquininha** no portal.
5. Depois que a maquininha se conectar ao Wi-Fi de operação, volte o celular à rede com internet para abrir o Banco Virtual.
6. A maquininha online e livre aparece automaticamente em **Maquininhas → Disponíveis para vincular** no painel do gestor. Se quiser cadastrá-la sem escolher um estabelecimento, use **Registrar pelo ID** e digite os quatro dígitos. Se dois aparelhos usarem o mesmo ID, gere outro no portal de um deles.
7. O gestor ou um aluno autorizado pode selecionar a maquininha disponível ou digitar seu ID ao vincular pelo estabelecimento. Depois de vinculada, ela sai da lista de disponíveis. No painel do gestor, **Renomear** altera o nome e **Desvincular** libera o terminal para outra conta e cancela as operações de cartão em andamento. **Excluir** remove o cadastro. Um aparelho excluído que continuar ligado pode voltar a aparecer como disponível.
8. O aluno comprador abre **Minha conta → Vincular cartão**, escolhe um terminal vinculado e online e aproxima o cartão em até um minuto. O gestor acompanha quem tem cartão e pode desfazer o vínculo.
9. Para cobrar, o vendedor abre **Meu estabelecimento → Efetuar venda**, digita o valor e toca **Cobrar no cartão**. Após a aproximação, o vendedor vê o resultado e pode converter a cobrança em Pix se necessário.

O broker informado já consta nos exemplos: `tokaido.proxy.rlwy.net:17906`. A configuração fornecida usa MQTT em TCP. As mensagens são assinadas com HMAC por maquininha. Para criptografar o transporte, configure um listener TLS no broker, use `mqtts://` no servidor e habilite `MQTT_TLS` com a CA correspondente no firmware. Se o broker exigir credenciais, configure `MQTT_USER` e `MQTT_PASSWORD`. Use o mesmo `MQTT_PREFIX` no servidor e nos terminais. Em um broker compartilhado, use um prefixo exclusivo desta instalação e, se disponível, permissões por tópico.

Se o painel mostrar a maquininha offline, abra a configuração dela e consulte **Conexão**. O Wi-Fi, o MQTT e a confirmação do banco aparecem separadamente. O banco confirma a identidade da maquininha e envia uma hora assinada para sincronizar o relógio. Em MQTT TCP, a conexão pode iniciar antes do NTP.

## Pix simulado

Em **Minha conta**, **Meu estabelecimento** ou **Conta do banco**, abra **Minhas chaves Pix** para ver e copiar as chaves da conta ou cadastrar uma nova. O simulador aceita chave aleatória, e-mail e celular fictícios, além de CPF fictício nas contas pessoais. O usuário ou o CNPJ cadastrado também funciona como chave.

Em **Enviar Pix**, cole a chave no campo único. O sistema reconhece a chave e mostra o destinatário antes da revisão. Se houver ambiguidade, use `@` antes do usuário, `+55` no celular ou a pontuação do documento. O pagamento sai do saldo da conta aberta.

Toque em uma movimentação no extrato para abrir o comprovante com valor, data, status, origem, destino e identificador. Quem recebeu pode devolver o Pix, e o estabelecimento pode estornar vendas por cartão. A devolução é integral, exige saldo e aparece como um novo registro associado ao original.

Para cobrar uma venda, o vendedor pode tocar **Gerar Pix** no teclado ou converter uma cobrança em aberto. A tela mostra o QR Code e o código completo para copiar. O comprador abre **Pagar cobrança** na conta que deseja usar e escaneia o QR Code, carrega uma foto ou cola o código. O código é exclusivo do Banco Virtual.

No celular, o navegador exige HTTPS e permissão de câmera para leitura ao vivo. O localhost é suficiente para testes no próprio computador. [Requisitos de câmera no navegador](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)

## Cobranças do banco

Em **Maquininhas → Configurar taxa**, o gestor define um percentual para todas as vendas no cartão. O banco usa a taxa vigente na confirmação do pagamento e arredonda para centavos. Com 10% em uma venda de R$ 10,00, o extrato do estabelecimento mostra R$ 10,00 de crédito da venda e R$ 1,00 de débito da taxa, creditado na conta do banco. Pix não tem essa taxa. No estorno da venda, o banco devolve a taxa original ao estabelecimento.

Em **Cobranças → Nova cobrança**, escolha um estabelecimento ou todos e salve um valor fixo ou um percentual. A cobrança fica no painel do gestor até ele clicar em **Lançar cobrança**. Cada lançamento usa os dados salvos naquele momento. Lançamentos para todos também chegam aos estabelecimentos cadastrados depois. O percentual usa o saldo do estabelecimento quando ele recebe a cobrança. Se o resultado for R$ 0,00, a cobrança aparece sem valor a pagar. É possível excluir cobranças salvas ou emitidas. Ao excluir uma cobrança paga, o pagamento e o comprovante permanecem no extrato.

Em **Meu estabelecimento → Cobranças do banco**, os alunos autorizados veem o que está pendente e podem pagar. O saldo do estabelecimento só é debitado na confirmação. O valor é creditado na **Conta do banco**, cujo saldo aparece na visão geral do gestor. O pagamento gera comprovante no extrato.

Em **Liberar saldo**, **Todas as contas** credita o mesmo valor por conta ativa de aluno ou estabelecimento.

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
