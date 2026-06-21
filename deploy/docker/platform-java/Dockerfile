FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build
COPY services/platform-java ./services/platform-java
RUN mvn -f services/platform-java/pom.xml -pl app -am package -DskipTests

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /build/services/platform-java/app/target/platform-app-0.1.0-SNAPSHOT.jar app.jar
HEALTHCHECK CMD curl -f http://localhost:8080/api/v1/health || exit 1
EXPOSE 8080
ENTRYPOINT ["java","-jar","app.jar"]
